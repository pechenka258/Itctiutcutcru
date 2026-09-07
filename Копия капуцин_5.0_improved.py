import logging
import os
import json
import sqlite3
import asyncio
from enum import Enum, auto
from datetime import datetime, timedelta
from collections import defaultdict, OrderedDict
from typing import Dict, List, Optional, Set

import pytz
from telegram import (
    Update, ForceReply, ChatPermissions, InlineKeyboardButton,
    InlineKeyboardMarkup, ReplyKeyboardMarkup, ReplyKeyboardRemove
)
from telegram.ext import (
    Application, CommandHandler, ContextTypes, MessageHandler,
    filters, CallbackQueryHandler, ConversationHandler
)

# ==============================================
# НАСТРОЙКИ ЛОГИРОВАНИЯ И КОНФИГУРАЦИИ
# ==============================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
    handlers=[
        logging.FileHandler(os.path.join(BASE_DIR, "bot.log")),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class Config:
    TOKEN = "YOUR_BOT_TOKEN"
    ADMIN_IDS = [123456789]  # Список ID администраторов (создатели/владельцы)
    DB_FILE = os.path.join(BASE_DIR, "user_stats.db")
    BACKUP_INTERVAL = 3600  # Интервал резервного копирования в секундах
    ACHIEVEMENTS_FILE = os.path.join(BASE_DIR, "achievements.json")
    REPORT_CHANNEL_ID = -1001234567890  # ID канала для репортов
    
    SPAM_LIMITS = {
        'max_messages': 5,
        'time_window': 10,
        'warn_limit': 3,
        'mute_duration': 300,
        'max_message_length': 1000
    }
    
    GREETINGS = {
        'enabled': True,
        'message': "👋 Добро пожаловать, {mention}! Прочитай правила в закреплённом сообщении.",
        'goodbye_message': "😢 Пользователь {mention} покинул чат.",
        'rules_message': "📜 Правила чата:\n1. Уважайте друг друга\n2. Не спамьте\n3. Не флудите"
    }
    
    REPORTS = {
        'enabled': True,
        'cooldown': 300,
        'types': ["Спам", "Оскорбления", "Неуместный контент", "Мошенничество", "Другое"]
    }

# ==============================================
# ПЕРЕЧИСЛЕНИЯ И КЛАССЫ ДАННЫХ
# ==============================================

class UserRole(Enum):
    MEMBER = auto()
    MODERATOR = auto()
    ADMIN = auto()
    CREATOR = auto()

class MediaType(Enum):
    PHOTO = auto()
    VIDEO = auto()
    VOICE = auto()
    STICKER = auto()
    DOCUMENT = auto()
    AUDIO = auto()
    ANIMATION = auto()
    POLL = auto()
    LOCATION = auto()
    CONTACT = auto()

class ReactionType(Enum):
    LIKE = auto()
    DISLIKE = auto()
    LOVE = auto()
    LAUGH = auto()
    WOW = auto()
    SAD = auto()
    ANGRY = auto()

class AchievementLevel(Enum):
    BRONZE = auto()
    SILVER = auto()
    GOLD = auto()
    PLATINUM = auto()
    DIAMOND = auto()

class ReportStatus(Enum):
    PENDING = auto()
    REVIEWED = auto()
    REJECTED = auto()
    PROCESSED = auto()

# ==============================================
# МОДЕЛИ ДАННЫХ
# ==============================================

class Achievement:
    def __init__(self, name: str, description: str, level: AchievementLevel, icon: str):
        self.name = name
        self.description = description
        self.level = level
        self.icon = icon

class UserActivity:
    def __init__(self):
        self.message_count = 0
        self.command_count = 0
        self.media_count = 0
        self.reaction_count = 0
        self.mention_count = 0
        self.poll_participation = 0
        self.violation_count = 0
        self.last_activity = datetime.now(pytz.utc)
        
    def update_activity(self):
        self.last_activity = datetime.now(pytz.utc)

class UserStats:
    def __init__(self, user_id: int):
        self.user_id = user_id
        self.join_date = datetime.now(pytz.utc)
        self.total_messages = 0
        self.total_chars = 0
        self.media_stats = {media_type: 0 for media_type in MediaType}
        self.reaction_stats = {reaction: 0 for reaction in ReactionType}
        self.mentions = 0
        self.warnings = 0
        self.bans = 0
        self.kicks = 0
        self.mutes = 0
        self.role = UserRole.MEMBER
        self.achievements = set()
        self.activity_by_hour = [0] * 24
        self.activity_by_day = [0] * 7
        self.daily_stats = OrderedDict()
        self.last_seen = datetime.now(pytz.utc)
        self.is_online = False
        self.rank_score = 0
        self.last_report_time = None
        
    def add_message(self, text: str = None):
        self.total_messages += 1
        if text:
            self.total_chars += len(text)
        self._update_activity()
        
    def add_media(self, media_type: MediaType):
        self.media_stats[media_type] += 1
        self._update_activity()
        
    def add_warning(self):
        self.warnings += 1
        self._update_activity()
        
    def add_ban(self):
        self.bans += 1
        self._update_activity()
        
    def add_mute(self):
        self.mutes += 1
        self._update_activity()
        
    def add_achievement(self, achievement: Achievement):
        self.achievements.add(achievement)
        self._update_activity()
        
    def can_report(self) -> bool:
        if self.last_report_time is None:
            return True
        return (datetime.now(pytz.utc) - self.last_report_time).total_seconds() >= Config.REPORTS['cooldown']
        
    def report_used(self):
        self.last_report_time = datetime.now(pytz.utc)
        self._update_activity()
        
    def _update_activity(self):
        now = datetime.now(pytz.utc)
        self.last_seen = now
        self.is_online = True
        
        hour = now.hour
        self.activity_by_hour[hour] += 1
        weekday = now.weekday()
        self.activity_by_day[weekday] += 1
        today = now.date()
        if today not in self.daily_stats:
            self.daily_stats[today] = UserActivity()
            if len(self.daily_stats) > 30:
                self.daily_stats.popitem(last=False)
        
        self.daily_stats[today].message_count += 1
        self.daily_stats[today].update_activity()
        self._update_rank_score()
    
    def _update_rank_score(self):
        base_score = self.total_messages * 1
        media_score = sum(self.media_stats.values()) * 2
        positive_score = (self.reaction_stats[ReactionType.LIKE] + 
                         self.reaction_stats[ReactionType.LOVE]) * 3
        negative_score = (self.warnings + self.bans + self.kicks) * -10
        self.rank_score = base_score + media_score + positive_score + negative_score

class Report:
    def __init__(self, reporter_id: int, reported_id: int, reason: str, message_id: int = None):
        self.reporter_id = reporter_id
        self.reported_id = reported_id
        self.reason = reason
        self.message_id = message_id
        self.status = ReportStatus.PENDING
        self.created_at = datetime.now(pytz.utc)
        self.processed_at = None
        self.processed_by = None
        
    def process(self, moderator_id: int, status: ReportStatus):
        self.status = status
        self.processed_by = moderator_id
        self.processed_at = datetime.now(pytz.utc)

# ==============================================
# ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ И КЭШ
# ==============================================

user_stats_cache: Dict[int, UserStats] = {}
admin_ids_cache: Set[int] = set()
user_warnings = defaultdict(int)
user_last_message_time = {}
user_message_count = defaultdict(int)
reports: Dict[int, Report] = {}
pending_reports: Dict[int, Report] = {}
db_conn = None
achievements_list: List[Achievement] = []

REPORT_REASON, REPORT_CONFIRM = range(2)

# ==============================================
# ЗАГЛУШКИ ОТСУТСТВУЮЩИХ ФУНКЦИЙ (добавлено для корректного запуска)
# ==============================================
async def user_statistics(update: Update, context: ContextTypes.DEFAULT_TYPE): pass
async def top_users(update: Update, context: ContextTypes.DEFAULT_TYPE): pass
async def user_profile(update: Update, context: ContextTypes.DEFAULT_TYPE): pass
async def show_achievements(update: Update, context: ContextTypes.DEFAULT_TYPE): pass
async def collect_stats(update: Update, context: ContextTypes.DEFAULT_TYPE): pass
async def check_achievements(stats, achievement_type: str): pass


# ==============================================
# ИНИЦИАЛИЗАЦИЯ И УТИЛИТЫ
# ==============================================

async def update_admins_cache(context: ContextTypes.DEFAULT_TYPE, chat_id: int):
    '''Динамически получает список админов чата и обновляет кэш.'''
    try:
        admins = await context.bot.get_chat_administrators(chat_id)
        admin_ids_cache.clear()
        for admin in admins:
            admin_ids_cache.add(admin.user.id)
        # Оставляем создателя из конфига на всякий случай
        admin_ids_cache.update(Config.ADMIN_IDS)
        logger.info(f"Обновлен список админов для чата {chat_id}: {admin_ids_cache}")
    except Exception as e:
        logger.error(f"Не удалось получить админов: {e}")

def init_database():
    global db_conn
    db_conn = sqlite3.connect(Config.DB_FILE)
    cursor = db_conn.cursor()
    cursor.execute('''CREATE TABLE IF NOT EXISTS user_stats (
        user_id INTEGER PRIMARY KEY, join_date TEXT NOT NULL, last_seen TEXT NOT NULL,
        total_messages INTEGER DEFAULT 0, total_chars INTEGER DEFAULT 0, warnings INTEGER DEFAULT 0,
        bans INTEGER DEFAULT 0, kicks INTEGER DEFAULT 0, mutes INTEGER DEFAULT 0, role TEXT DEFAULT 'MEMBER',
        rank_score INTEGER DEFAULT 0, last_report_time TEXT)''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS user_media_stats (
        user_id INTEGER, media_type TEXT, count INTEGER DEFAULT 0, PRIMARY KEY (user_id, media_type),
        FOREIGN KEY (user_id) REFERENCES user_stats (user_id))''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS user_reaction_stats (
        user_id INTEGER, reaction_type TEXT, count INTEGER DEFAULT 0, PRIMARY KEY (user_id, reaction_type),
        FOREIGN KEY (user_id) REFERENCES user_stats (user_id))''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS user_achievements (
        user_id INTEGER, achievement_name TEXT, PRIMARY KEY (user_id, achievement_name),
        FOREIGN KEY (user_id) REFERENCES user_stats (user_id))''')
    cursor.execute('''CREATE TABLE IF NOT EXISTS reports (
        report_id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id INTEGER NOT NULL, reported_id INTEGER NOT NULL,
        reason TEXT NOT NULL, message_id INTEGER, status TEXT NOT NULL, created_at TEXT NOT NULL,
        processed_at TEXT, processed_by INTEGER, FOREIGN KEY (reporter_id) REFERENCES user_stats (user_id),
        FOREIGN KEY (reported_id) REFERENCES user_stats (user_id))''')
    db_conn.commit()

def load_achievements():
    global achievements_list
    try:
        if os.path.exists(Config.ACHIEVEMENTS_FILE):
            with open(Config.ACHIEVEMENTS_FILE, 'r', encoding='utf-8') as f:
                achievements_data = json.load(f)
            for ach_data in achievements_data:
                achievement = Achievement(
                    name=ach_data['name'], description=ach_data['description'],
                    level=AchievementLevel[ach_data['level']], icon=ach_data['icon']
                )
                achievements_list.append(achievement)
            logger.info(f"Loaded {len(achievements_list)} achievements")
        else:
            raise FileNotFoundError("Achievements file not found.")
    except Exception as e:
        logger.error(f"Failed to load achievements: {e}")
        achievements_list = [
            Achievement("Новичок", "Отправил первое сообщение", AchievementLevel.BRONZE, "👶"),
            Achievement("Активный", "100 сообщений", AchievementLevel.SILVER, "💬")
        ]

def save_stats_to_db():
    if not db_conn: return
    cursor = db_conn.cursor()
    for user_id, stats in user_stats_cache.items():
        cursor.execute('''INSERT OR REPLACE INTO user_stats 
        (user_id, join_date, last_seen, total_messages, total_chars, warnings, bans, kicks, mutes, role, rank_score, last_report_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''', (
            user_id, stats.join_date.isoformat(), stats.last_seen.isoformat(), stats.total_messages,
            stats.total_chars, stats.warnings, stats.bans, stats.kicks, stats.mutes, stats.role.name,
            stats.rank_score, stats.last_report_time.isoformat() if stats.last_report_time else None
        ))
    db_conn.commit()

async def backup_stats_job(context: ContextTypes.DEFAULT_TYPE):
    '''Периодическая задача сохранения БД'''
    try:
        save_stats_to_db()
        logger.info("Stats backup completed successfully")
    except Exception as e:
        logger.error(f"Backup failed: {e}")

def load_stats_from_db():
    if not db_conn: return
    cursor = db_conn.cursor()
    cursor.execute("SELECT * FROM user_stats")
    for row in cursor.fetchall():
        user_id = row[0]
        stats = UserStats(user_id)
        stats.join_date = datetime.fromisoformat(row[1])
        stats.total_messages = row[3]
        user_stats_cache[user_id] = stats

# ==============================================
# ОСНОВНЫЕ ФУНКЦИИ БОТА
# ==============================================

async def get_user_stats(update: Update, context: ContextTypes.DEFAULT_TYPE, user_id: int = None) -> Optional[UserStats]:
    if not user_id:
        if not update.effective_user: return None
        user_id = update.effective_user.id
    if user_id not in user_stats_cache:
        user_stats_cache[user_id] = UserStats(user_id)
    return user_stats_cache[user_id]

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    chat = update.effective_chat
    
    # Обновляем админов при старте в группе
    if chat.type != "private":
        await update_admins_cache(context, chat.id)
        
    if chat.type == "private":
        await update.message.reply_text("Добавь меня в группу и дай права администратора.")
    else:
        await update.message.reply_text(f"Привет, {user.mention_html()}! Используй /help.", parse_mode="HTML")

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    help_text = "📚 <b>Доступные команды:</b>\n/start, /help, /report и т.д."
    await update.message.reply_text(help_text, parse_mode="HTML")

# ==============================================
# СИСТЕМА ПИНГА И РЕПОРТОВ
# ==============================================

async def ping_all_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    # Динамическая проверка прав администратора
    if update.effective_user.id not in Config.ADMIN_IDS and update.effective_user.id not in admin_ids_cache:
        await update.message.reply_text("У вас нет прав для использования этой команды.")
        return
    await update.message.reply_text("Функция пинга всех запущена (заглушка).")

async def report_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not Config.REPORTS['enabled']:
        await update.message.reply_text("Система репортов отключена.")
        return
    if not update.message.reply_to_message:
        await update.message.reply_text("Используйте в ответ на сообщение пользователя.")
        return
    
    # Сохраняем в context, логика выбора кнопок...
    context.user_data['report'] = {
        'reported_id': update.message.reply_to_message.from_user.id,
        'reported_name': update.message.reply_to_message.from_user.username,
        'message_id': update.message.reply_to_message.message_id
    }
    keyboard = [[InlineKeyboardButton(r, callback_data=f"report_{i}")] for i, r in enumerate(Config.REPORTS['types'])]
    keyboard.append([InlineKeyboardButton("Отмена", callback_data="report_cancel")])
    await update.message.reply_text("Выберите причину жалобы:", reply_markup=InlineKeyboardMarkup(keyboard))
    return REPORT_REASON

async def report_cancel_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.callback_query.edit_message_text("Отменено.")
    return ConversationHandler.END

# ==============================================
# ЗАПУСК БОТА
# ==============================================
def main() -> None:
    init_database()
    load_achievements()
    load_stats_from_db()
    
    application = Application.builder().token(Config.TOKEN).build()
    
    # 🌟 Исправление фоновых задач (теперь работает через JobQueue, не блокирует run_polling)
    application.job_queue.run_repeating(backup_stats_job, interval=Config.BACKUP_INTERVAL)
    
    command_handlers = [
        CommandHandler("start", start),
        CommandHandler("help", help_command),
        CommandHandler("pingall", ping_all_command),
    ]
    for handler in command_handlers: application.add_handler(handler)
    
    application.add_handler(MessageHandler(filters.ALL & ~filters.COMMAND, collect_stats))
    
    application.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()
