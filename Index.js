const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
require('dotenv').config();

// ==============================================
// 1. ЛОГГЕР И КОНФИГУРАЦИЯ
// ==============================================
const logger = {
    info: (...args) => console.log(`[INFO] [${new Date().toISOString()}]`, ...args),
    warn: (...args) => console.warn(`[WARN] [${new Date().toISOString()}]`, ...args),
    error: (...args) => console.error(`[ERROR] [${new Date().toISOString()}]`, ...args)
};

const Config = {
    ADMIN_IDS: [123456789], // Укажите ваш Telegram ID (Владелец)
    DEV_ID: 6138397255,      // ID разработчика
    DEV_USERNAME: '@tqp0k',  // Тег разработчика
    SPAM_LIMITS: {
        max_messages: 5,
        time_window: 10000,
        warn_limit: 3,
        mute_duration: 300000,
        max_message_length: 1000
    },
    FILTERS: {
        ALLOW_LINKS: false,
        BLOCK_TELEGRAM_INVITES: true
    },
    GREETINGS: {
        enabled: true,
        message: "👋 Добро пожаловать, {mention} в {chat_title}! Вы {count}-й участник. Прочитай правила командой /rules или просто напиши слово правила.",
        goodbye_message: "😢 Пользователь {mention} покинул чат."
    },
    REPORTS: {
        enabled: true,
        cooldown: 300000,
        types: ["Спам", "Оскорбления", "Неуместный контент", "Мошенничество", "Другое"]
    },
    RANKS: {
        OWNER: 5,
        SENIOR_ADMIN: 4,
        ADMIN: 3,
        MODERATOR: 2,
        HELPER: 1
    },
    FUN: {
        duelXp: 25,
        slotXp: 25,
        rpsXp: 10,
        karmaDailyLimit: 3
    },
    WARN_RESET_DAYS: 7,
    WARN_CHECK_INTERVAL: 3600000,
    // ============ НАСТРОЙКИ ИИ ============
    AI: {
        enabled: true,
        // Бесплатная модель OpenRouter (можно менять)
        model: "z-ai/glm-4.6:free",
        // Альтернативные бесплатные модели:
        // "deepseek/deepseek-chat-v3.1:free"
        // "qwen/qwen3-coder:free"
        // "meta-llama/llama-3.3-70b-instruct:free"
        // "google/gemini-2.0-flash-exp:free"
        maxTokens: 800,
        temperature: 0.7,
        historyLimit: 10, // Сколько сообщений хранить в контексте
        systemPrompt: "Ты — дружелюбный и полезный ИИ-ассистент в Telegram-боте по имени Капуцин. Отвечай кратко, по делу, с юмором когда уместно. Отвечай на русском языке.",
        cooldown: 5000 // Антиспам: 5 секунд между запросами
    }
};

// Права для разных рангов
const RANK_PERMISSIONS = {
    [Config.RANKS.OWNER]: ['all'],
    [Config.RANKS.SENIOR_ADMIN]: ['all'],
    [Config.RANKS.ADMIN]: ['moderation', 'warn', 'mute', 'kick', 'ban', 'unban', 'unmute', 'welcome', 'rules', 'badwords', 'addcmd', 'delcmd'],
    [Config.RANKS.MODERATOR]: ['moderation', 'warn', 'mute', 'kick', 'rules'],
    [Config.RANKS.HELPER]: ['warn', 'rules', 'addcmd', 'delcmd']
};

// Минимальный ранг для каждой команды
const COMMAND_REQUIREMENTS = {
    'kick': Config.RANKS.MODERATOR,
    'ban': Config.RANKS.ADMIN,
    'unban': Config.RANKS.ADMIN,
    'mute': Config.RANKS.MODERATOR,
    'unmute': Config.RANKS.MODERATOR,
    'warn': Config.RANKS.HELPER,
    'unwarn': Config.RANKS.MODERATOR,
    'setrules': Config.RANKS.HELPER,
    'setwelcome': Config.RANKS.ADMIN,
    'nightmode': Config.RANKS.ADMIN,
    'addcmd': Config.RANKS.HELPER,
    'delcmd': Config.RANKS.HELPER,
    'customcmds': Config.RANKS.HELPER,
    'addword': Config.RANKS.ADMIN,
    'delword': Config.RANKS.ADMIN,
    'badwords': Config.RANKS.MODERATOR,
};

const FULL_CHAT_PERMISSIONS = {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true
};

// ==============================================
// 1.1. ИНИЦИАЛИЗАЦИЯ ИИ (OPENROUTER)
// ==============================================
let aiClient = null;
if (Config.AI.enabled && process.env.OPENROUTER_API_KEY) {
    aiClient = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
        defaultHeaders: {
            "HTTP-Referer": "https://t.me/" + (Config.DEV_USERNAME || "bot"),
            "X-Title": "Kapucin Bot"
        }
    });
    logger.info(`🤖 ИИ инициализирован. Модель: ${Config.AI.model}`);
} else {
    logger.warn('⚠️ ИИ отключён: отсутствует OPENROUTER_API_KEY или AI.enabled = false');
}

// Карта кулдаунов для ИИ-запросов
const aiCooldowns = new Map();

/**
 * Отправка запроса к ИИ с учётом истории диалога
 */
async function askAI(userId, prompt, userName) {
    if (!aiClient) throw new Error("ИИ не инициализирован");

    const user = getUser(userId, userName);
    if (!user.aiHistory) user.aiHistory = [];

    // Формируем сообщения: system + история + новый запрос
    const messages = [
        { role: "system", content: Config.AI.systemPrompt },
        ...user.aiHistory.slice(-Config.AI.historyLimit),
        { role: "user", content: prompt }
    ];

    const completion = await aiClient.chat.completions.create({
        model: Config.AI.model,
        messages: messages,
        max_tokens: Config.AI.maxTokens,
        temperature: Config.AI.temperature
    });

    const reply = completion.choices[0]?.message?.content?.trim() || "🤖 Не удалось получить ответ.";

    // Сохраняем в историю
    user.aiHistory.push({ role: "user", content: prompt });
    user.aiHistory.push({ role: "assistant", content: reply });
    // Обрезаем историю
    if (user.aiHistory.length > Config.AI.historyLimit * 2) {
        user.aiHistory = user.aiHistory.slice(-Config.AI.historyLimit * 2);
    }

    saveDb();
    return reply;
}

// ==============================================
// 2. ДОСТИЖЕНИЯ (38 шт., часть — скрытые)
// ==============================================
const ACHIEVEMENTS = [
    { id: 'first_msg', icon: '👶', name: 'Новичок', desc: 'Отправить первое сообщение', hidden: false,
      progress: u => `${Math.min(u.totalMessages || 0, 1)}/1`, check: u => (u.totalMessages || 0) >= 1 },
    { id: 'active100', icon: '💬', name: 'Активный', desc: '100 сообщений', hidden: false,
      progress: u => `${Math.min(u.totalMessages || 0, 100)}/100`, check: u => (u.totalMessages || 0) >= 100 },
    { id: 'bol500', icon: '🗣', name: 'Болтун', desc: '500 сообщений', hidden: false,
      progress: u => `${Math.min(u.totalMessages || 0, 500)}/500`, check: u => (u.totalMessages || 0) >= 500 },
    { id: 'pis1000', icon: '✍️', name: 'Писатель', desc: '1000 сообщений', hidden: false,
      progress: u => `${Math.min(u.totalMessages || 0, 1000)}/1000`, check: u => (u.totalMessages || 0) >= 1000 },
    { id: 'book5000', icon: '📚', name: 'Многорукий', desc: '5000 сообщений', hidden: false,
      progress: u => `${Math.min(u.totalMessages || 0, 5000)}/5000`, check: u => (u.totalMessages || 0) >= 5000 },
    { id: 'legend10000', icon: '🏛', name: 'Живая легенда', desc: '10000 сообщений', hidden: false,
      progress: u => `${Math.min(u.totalMessages || 0, 10000)}/10000`, check: u => (u.totalMessages || 0) >= 10000 },
    { id: 'media50', icon: '📷', name: 'Медиамагнат', desc: '50 медиафайлов', hidden: false,
      progress: u => `${Math.min(totalMedia(u), 50)}/50`, check: u => totalMedia(u) >= 50 },
    { id: 'video100', icon: '🎬', name: 'Видеоблогер', desc: '100 видео и гифок', hidden: false,
      progress: u => `${Math.min((u.mediaStats?.VIDEO || 0) + (u.mediaStats?.ANIMATION || 0), 100)}/100`,
      check: u => ((u.mediaStats?.VIDEO || 0) + (u.mediaStats?.ANIMATION || 0)) >= 100 },
    { id: 'voice50', icon: '🎙', name: 'Голосовой болтун', desc: '50 голосовых', hidden: false,
      progress: u => `${Math.min(u.mediaStats?.VOICE || 0, 50)}/50`, check: u => (u.mediaStats?.VOICE || 0) >= 50 },
    { id: 'doc50', icon: '📄', name: 'Документалист', desc: '50 документов', hidden: false,
      progress: u => `${Math.min(u.mediaStats?.DOCUMENT || 0, 50)}/50`, check: u => (u.mediaStats?.DOCUMENT || 0) >= 50 },
    { id: 'sticker100', icon: '😄', name: 'Коллекционер стикеров', desc: '100 стикеров', hidden: false,
      progress: u => `${Math.min(u.mediaStats?.STICKER || 0, 100)}/100`, check: u => (u.mediaStats?.STICKER || 0) >= 100 },
    { id: 'lvl3', icon: '🌱', name: 'Первые шаги', desc: 'Достичь 3 уровня', hidden: false,
      progress: u => `${Math.min(u.level || 1, 3)}/3`, check: u => (u.level || 1) >= 3 },
    { id: 'lvl5', icon: '🌟', name: 'Опытный', desc: 'Достичь 5 уровня', hidden: false,
      progress: u => `${Math.min(u.level || 1, 5)}/5`, check: u => (u.level || 1) >= 5 },
    { id: 'lvl10', icon: '📖', name: 'Знаток', desc: 'Достичь 10 уровня', hidden: false,
      progress: u => `${Math.min(u.level || 1, 10)}/10`, check: u => (u.level || 1) >= 10 },
    { id: 'lvl15', icon: '⚔️', name: 'Гуру общения', desc: 'Достичь 15 уровня', hidden: false,
      progress: u => `${Math.min(u.level || 1, 15)}/15`, check: u => (u.level || 1) >= 15 },
    { id: 'lvl20', icon: '👑', name: 'Легенда чата', desc: 'Достичь 20 уровня', hidden: false,
      progress: u => `${Math.min(u.level || 1, 20)}/20`, check: u => (u.level || 1) >= 20 },
    { id: 'karma10', icon: '❤️', name: 'Милосердный', desc: '10 кармы', hidden: false,
      progress: u => `${Math.min(u.karma || 0, 10)}/10`, check: u => (u.karma || 0) >= 10 },
    { id: 'karma50', icon: '💎', name: 'Уважаемый', desc: '50 кармы', hidden: false,
      progress: u => `${Math.min(u.karma || 0, 50)}/50`, check: u => (u.karma || 0) >= 50 },
    { id: 'karma100', icon: '🌈', name: 'Душа компании', desc: '100 кармы', hidden: false,
      progress: u => `${Math.min(u.karma || 0, 100)}/100`, check: u => (u.karma || 0) >= 100 },
    { id: 'guard10', icon: '🛡️', name: 'Страж', desc: 'Отправить 10 репортов', hidden: false,
      progress: u => `${Math.min(reportsByUser(u.userId), 10)}/10`, check: u => reportsByUser(u.userId) >= 10 },
    { id: 'guard25', icon: '🚨', name: 'Народный контроль', desc: 'Отправить 25 репортов', hidden: false,
      progress: u => `${Math.min(reportsByUser(u.userId), 25)}/25`, check: u => reportsByUser(u.userId) >= 25 },
    { id: 'duel5', icon: '⚔️', name: 'Дуэлянт', desc: '5 побед в дуэлях', hidden: false,
      progress: u => `${Math.min(u.funStats?.duelWins || 0, 5)}/5`, check: u => (u.funStats?.duelWins || 0) >= 5 },
    { id: 'duel20', icon: '🏆', name: 'Чемпион арены', desc: '20 побед в дуэлях', hidden: false,
      progress: u => `${Math.min(u.funStats?.duelWins || 0, 20)}/20`, check: u => (u.funStats?.duelWins || 0) >= 20 },
    { id: 'slots3', icon: '🎰', name: 'Счастливчик', desc: '3 победы в слотах', hidden: false,
      progress: u => `${Math.min(u.funStats?.slotsWins || 0, 3)}/3`, check: u => (u.funStats?.slotsWins || 0) >= 3 },
    { id: 'rps5', icon: '🤖', name: 'Победитель машин', desc: '5 побед над ботом в КНБ', hidden: false,
      progress: u => `${Math.min(u.funStats?.rpsWins || 0, 5)}/5`, check: u => (u.funStats?.rpsWins || 0) >= 5 },
    { id: 'coin10', icon: '🪙', name: 'Орёл или решка', desc: 'Подбросить монетку 10 раз', hidden: false,
      progress: u => `${Math.min(u.funStats?.coinFlips || 0, 10)}/10`, check: u => (u.funStats?.coinFlips || 0) >= 10 },
    { id: 'ai_first', icon: '🧠', name: 'Диалог с ИИ', desc: 'Задать первый вопрос ИИ', hidden: false,
      progress: u => `${Math.min(u.funStats?.aiAsks || 0, 1)}/1`, check: u => (u.funStats?.aiAsks || 0) >= 1 },
    { id: 'ai_50', icon: '🤖', name: 'Друг ИИ', desc: 'Задать 50 вопросов ИИ', hidden: false,
      progress: u => `${Math.min(u.funStats?.aiAsks || 0, 50)}/50`, check: u => (u.funStats?.aiAsks || 0) >= 50 },

    { id: 'warn1', icon: '😈', name: 'Злостный нарушитель', desc: 'Получить первое предупреждение', hidden: true,
      progress: () => '???', check: u => (u.warnings || 0) >= 1 || (u.warnHistory || []).length > 0 },
    { id: 'hooligan', icon: '🔥', name: 'Хулиган', desc: 'Словить мут за 3 нарушения', hidden: true,
      progress: () => '???', check: u => !!(u.funStats?.punished3strikes) },
    { id: 'ban1', icon: '⛔', name: 'Мрак', desc: 'Быть забаненным', hidden: true,
      progress: () => '???', check: u => (u.bans || 0) >= 1 },
    { id: 'phoenix', icon: '🦅', name: 'Феникс', desc: 'Вернуться после бана', hidden: true,
      progress: () => '???', check: u => !!(u.funStats?.phoenix) },
    { id: 'night1', icon: '🌙', name: 'Полуночник', desc: 'Написать сообщение с 00:00 до 04:00', hidden: true,
      progress: () => '???', check: u => (u.funStats?.nightMessages || 0) >= 1 },
    { id: 'early1', icon: '🐦', name: 'Ранняя пташка', desc: 'Написать сообщение до 06:00', hidden: true,
      progress: () => '???', check: u => (u.funStats?.earlyMessages || 0) >= 1 },
    { id: 'mute1', icon: '🤫', name: 'Молчун', desc: 'Побывать в муте', hidden: true,
      progress: () => '???', check: u => (u.mutes || 0) >= 1 },
    { id: 'spam1', icon: '📢', name: 'Спамер', desc: 'Попасться спам-фильтру', hidden: true,
      progress: () => '???', check: u => (u.funStats?.spamCaught || 0) >= 1 },
    { id: 'filtered1', icon: '📝', name: 'На заметке', desc: 'Сообщение удалено фильтром', hidden: true,
      progress: () => '???', check: u => (u.filteredMessages || 0) >= 1 },
    { id: 'dmbot', icon: '🤖', name: 'Друг бота', desc: 'Написать боту в личку', hidden: true,
      progress: () => '???', check: u => !!(u.funStats?.dmBot) },
    { id: 'draw1', icon: '🍀', name: 'Счастливый случай', desc: 'Сыграть вничью в дуэли', hidden: true,
      progress: () => '???', check: u => (u.funStats?.duelDraws || 0) >= 1 },
    { id: 'karma200', icon: '💰', name: 'Банкир', desc: 'Накопить 200 кармы', hidden: true,
      progress: () => '???', check: u => (u.karma || 0) >= 200 }
];

const OLD_ACHIEVEMENT_NAMES = {
    'Новичок': 'first_msg', 'Активный': 'active100', 'Болтун': 'bol500',
    'Писатель': 'pis1000', 'Медиамагнат': 'media50', 'Страж': 'guard10'
};

function totalMedia(user) {
    return Object.values(user.mediaStats || {}).reduce((a, b) => a + b, 0);
}

function reportsByUser(userId) {
    return (dbData.reports || []).filter(r => r.reporterId === userId).length;
}

function checkAchievements(user, ctx) {
    if (!user || !user.achievements) return;
    for (const ach of ACHIEVEMENTS) {
        if (!user.achievements.includes(ach.id) && ach.check(user)) {
            user.achievements.push(ach.id);
            if (ctx && ctx.replyWithHTML) {
                ctx.replyWithHTML(`🏆 <b>Новое достижение: ${ach.icon} ${ach.name}!</b>\n<i>${ach.desc}</i>`).catch(() => {});
            }
        }
    }
}

function buildAchievementsText(user) {
    const unlocked = new Set(user.achievements || []);
    const visible = ACHIEVEMENTS.filter(a => !a.hidden);
    const hidden = ACHIEVEMENTS.filter(a => a.hidden);
    const unlockedCount = ACHIEVEMENTS.filter(a => unlocked.has(a.id)).length;

    let text = `🏆 <b>ДОСТИЖЕНИЯ</b>\n\n<b>${escapeHtml(user.name)}</b> — получено: ${unlockedCount}/${ACHIEVEMENTS.length}\n\n`;

    text += `<b>📖 Обычные:</b>\n`;
    for (const a of visible) {
        if (unlocked.has(a.id)) {
            text += `${a.icon} <b>${a.name}</b> — ${a.desc}\n`;
        } else {
            text += `▫️ <b>${a.name}</b> — ${a.desc} <code>[${a.progress(user)}]</code>\n`;
        }
    }

    text += `\n<b>🎭 Скрытые:</b>\n`;
    for (const a of hidden) {
        if (unlocked.has(a.id)) {
            text += `${a.icon} <b>${a.name}</b> — ${a.desc}\n`;
        } else {
            text += `❓ <b>???</b>\n`;
        }
    }

    text += `\n<i>Скрытые достижения раскрываются, когда вы их получаете. Удачи в поисках! 😉</i>`;
    return text;
}

// ==============================================
// 3. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==============================================
function getTodayKey() {
    return new Date().toISOString().split('T')[0];
}

function getWeekKey() {
    const d = new Date();
    const year = d.getFullYear();
    const firstDayOfYear = new Date(year, 0, 1);
    const pastDaysOfYear = (d - firstDayOfYear) / 86400000;
    const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
    return `${year}-W${weekNum}`;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function getProgressBar(xp, reqXp) {
    const total = 10;
    if (!reqXp || reqXp <= 0) return '░'.repeat(total);
    const progress = Math.min(Math.floor((xp / reqXp) * total), total);
    return '▓'.repeat(progress) + '░'.repeat(total - progress);
}

function getTitleByLevel(level) {
    if (level >= 20) return "👑 Легенда чата";
    if (level >= 15) return "⚔️ Гуру общения";
    if (level >= 10) return "🌟 Знаток";
    if (level >= 5) return "💬 Активный собеседник";
    return "🌱 Новичок";
}

function isNightTime(startHour = 23, endHour = 7) {
    const hour = new Date().getHours();
    if (startHour > endHour) {
        return hour >= startHour || hour < endHour;
    }
    return hour >= startHour && hour < endHour;
}

const userSpamMap = new Map();

function isSpamming(userId, chatId) {
    const now = Date.now();
    const key = `${chatId}_${userId}`;
    if (!userSpamMap.has(key)) {
        userSpamMap.set(key, []);
    }
    const timestamps = userSpamMap.get(key);
    while (timestamps.length > 0 && timestamps[0] < now - Config.SPAM_LIMITS.time_window) {
        timestamps.shift();
    }
    timestamps.push(now);
    return timestamps.length > Config.SPAM_LIMITS.max_messages;
}

function getRankName(rank) {
    switch (rank) {
        case 5: return "👑 Владелец";
        case 4: return "⭐ Старший админ";
        case 3: return "🛡️ Админ";
        case 2: return "🔧 Модератор";
        case 1: return "💬 Хелпер";
        default: return "❓ Неизвестно";
    }
}

function isDeveloper(userId) {
    return userId === Config.DEV_ID || Config.ADMIN_IDS.includes(userId);
}

function hasPermission(rank, permission) {
    const perms = RANK_PERMISSIONS[rank] || [];
    return perms.includes('all') || perms.includes(permission);
}

// ==============================================
// 4. ХРАНИЛИЩЕ ДАННЫХ
// ==============================================
const DB_FILE = path.join(__dirname, 'database.json');
let dbData = {
    users: {},
    chats: {},
    reports: [],
    knownChats: [],
    config: {
        nightMode: { enabled: false, startHour: 23, endHour: 7 },
        antiRaid: { enabled: true, joinLimit: 5, activeUntil: 0 }
    }
};

let saveTimeout = null;
function saveDb() {
    if (saveTimeout) return;
    saveTimeout = setTimeout(() => {
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');
        } catch (e) {
            logger.error('Ошибка сохранения БД:', e);
        } finally {
            saveTimeout = null;
        }
    }, 2000);
}

function saveDbSync() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');
    } catch (e) {
        logger.error('Ошибка при синхронном сохранении БД:', e);
    }
}

function loadDb() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            dbData = { ...dbData, ...parsed };
            if (!dbData.users) dbData.users = {};
            if (!dbData.reports) dbData.reports = [];
            if (!dbData.knownChats) dbData.knownChats = [];
            if (!dbData.chats) dbData.chats = {};

            dbData.config = {
                nightMode: { enabled: false, startHour: 23, endHour: 7 },
                antiRaid: { enabled: true, joinLimit: 5, activeUntil: 0 },
                ...(dbData.config || {})
            };

            for (const uid in dbData.users) {
                const u = dbData.users[uid];
                if (Array.isArray(u.achievements)) {
                    u.achievements = u.achievements.map(a => OLD_ACHIEVEMENT_NAMES[a] || a)
                        .filter(a => ACHIEVEMENTS.some(x => x.id === a));
                }
            }

            logger.info('База данных успешно загружена.');
        } catch (e) {
            logger.error('Ошибка чтения файла БД:', e);
        }
    }
}

function ensureUserDefaults(user) {
    const fields = {
        totalMessages: 0, totalChars: 0, warnings: 0, warnMuted: false,
        mutes: 0, bans: 0, rankScore: 0, karma: 0, xp: 0, level: 1,
        karmaGivenToday: 0, adminRank: 0, warnStage: 1,
        filteredMessages: 0, spamStrikes: 0, lastWarnDate: null
    };
    for (const k in fields) {
        if (user[k] === undefined) user[k] = fields[k];
    }
    if (!user.lastKarmaReset) user.lastKarmaReset = getTodayKey();
    if (!user.lastReportTime) user.lastReportTime = null;
    if (!user.joinDate) user.joinDate = new Date().toISOString();
    if (!user.lastSeen) user.lastSeen = new Date().toISOString();
    if (!user.mediaStats) user.mediaStats = { PHOTO: 0, VIDEO: 0, VOICE: 0, STICKER: 0, DOCUMENT: 0, ANIMATION: 0 };
    if (!Array.isArray(user.achievements)) user.achievements = [];
    if (!user.adminChats) user.adminChats = {};
    if (!Array.isArray(user.warnHistory)) user.warnHistory = [];
    if (!Array.isArray(user.aiHistory)) user.aiHistory = [];
    if (!user.funStats) user.funStats = {};
    const fsDefaults = {
        duelWins: 0, duelDraws: 0, slotsWins: 0, rpsWins: 0, ballAsks: 0,
        coinFlips: 0, nightMessages: 0, earlyMessages: 0, spamCaught: 0,
        phoenix: false, punished3strikes: false, dmBot: false,
        aiAsks: 0, aiMode: false
    };
    for (const k in fsDefaults) {
        if (user.funStats[k] === undefined) user.funStats[k] = fsDefaults[k];
    }
    return user;
}

function getUser(userId, userName = null, username = null) {
    if (!dbData.users) dbData.users = {};

    if (!dbData.users[userId]) {
        dbData.users[userId] = {
            userId,
            name: userName || `Пользователь ${userId}`,
            username: username ? username.replace('@', '') : null,
            joinDate: new Date().toISOString(),
            lastSeen: new Date().toISOString()
        };
    } else {
        if (userName && userName.trim() !== '' && userName !== 'Пользователь') {
            dbData.users[userId].name = userName;
        }
        if (username) {
            dbData.users[userId].username = username.replace('@', '');
        }
    }

    return ensureUserDefaults(dbData.users[userId]);
}

function checkAndResetWarns(user) {
    if (!user) return false;
    const now = new Date();
    let changed = false;

    if (user.warnings > 0 && user.lastWarnDate) {
        const lastWarn = new Date(user.lastWarnDate);
        const daysPassed = Math.floor((now - lastWarn) / (1000 * 60 * 60 * 24));
        if (daysPassed >= Config.WARN_RESET_DAYS) {
            user.warnings = 0;
            user.lastWarnDate = null;
            user.warnMuted = false;
            user.warnStage = 1;
            user.warnHistory = [];
            changed = true;
        }
    }

    if (user.warnMuted && user.lastWarnDate) {
        const lastWarn = new Date(user.lastWarnDate);
        const daysPassed = Math.floor((now - lastWarn) / (1000 * 60 * 60 * 24));
        if (daysPassed >= Config.WARN_RESET_DAYS) {
            user.warnMuted = false;
            user.warnStage = 1;
            changed = true;
        }
    }

    return changed;
}

function addXp(user, amount, ctx) {
    if (!user || user.xp === undefined) return;
    user.xp += amount;
    let reqXp = user.level * 50;
    while (user.xp >= reqXp) {
        user.xp -= reqXp;
        user.level++;
        reqXp = user.level * 50;
        if (ctx && ctx.replyWithHTML) {
            ctx.replyWithHTML(`🎉 Поздравляем, <b>${escapeHtml(user.name)}</b>! Вы достигли ${user.level} уровня! (${getTitleByLevel(user.level)})`).catch(() => {});
        }
    }
}

function getChatData(chatId, chatTitle = "Чат") {
    if (!dbData.chats) dbData.chats = {};
    if (!dbData.chats[chatId]) {
        dbData.chats[chatId] = {
            id: chatId,
            title: chatTitle,
            totalMessages: 0,
            dailyStats: {},
            weeklyStats: {},
            userActivity: {},
            rules: "📜 Правила чата:\n1. Уважайте друг друга\n2. Не спамьте и не используйте мат\n3. Реклама запрещена",
            badWords: ['скам', 'казино', 'крипта'],
            allowedDomains: ['github.com', 'google.com', 'youtube.com'],
            customCommands: {},
            welcomeMessage: Config.GREETINGS.message,
            scheduledPosts: []
        };
    }
    if (chatTitle && chatTitle !== "Чат") {
        dbData.chats[chatId].title = chatTitle;
    }

    const chat = dbData.chats[chatId];
    if (!chat.rules) chat.rules = "📜 Правила чата:\n1. Уважайте друг друга\n2. Не спамьте и не используйте мат\n3. Реклама запрещена";
    if (!Array.isArray(chat.badWords)) chat.badWords = ['скам', 'казино', 'крипта'];
    if (!Array.isArray(chat.allowedDomains)) chat.allowedDomains = ['github.com', 'google.com', 'youtube.com'];
    if (!chat.customCommands) chat.customCommands = {};
    if (!chat.welcomeMessage) chat.welcomeMessage = Config.GREETINGS.message;
    if (!Array.isArray(chat.scheduledPosts)) chat.scheduledPosts = [];
    if (!chat.dailyStats) chat.dailyStats = {};
    if (!chat.weeklyStats) chat.weeklyStats = {};
    if (!chat.userActivity) chat.userActivity = {};
    if (!chat.totalMessages) chat.totalMessages = 0;

    if (!dbData.knownChats) dbData.knownChats = [];
    if (!dbData.knownChats.includes(chatId)) {
        dbData.knownChats.push(chatId);
        saveDb();
    }

    return chat;
}

function trackMessage(ctx) {
    if (!ctx.chat || ctx.chat.type === 'private') return;

    const userId = ctx.from.id;
    const userName = ctx.from.first_name || "Пользователь";
    const chatId = ctx.chat.id;
    const chatTitle = ctx.chat.title || "Чат";

    const user = getUser(userId, userName, ctx.from.username);
    const chat = getChatData(chatId, chatTitle);

    const today = getTodayKey();
    const week = getWeekKey();

    chat.totalMessages = (chat.totalMessages || 0) + 1;
    chat.dailyStats[today] = (chat.dailyStats[today] || 0) + 1;
    chat.weeklyStats[week] = (chat.weeklyStats[week] || 0) + 1;

    if (!chat.userActivity[userId]) {
        chat.userActivity[userId] = { name: userName, count: 0 };
    }
    chat.userActivity[userId].count += 1;
    chat.userActivity[userId].name = userName;

    user.totalMessages = (user.totalMessages || 0) + 1;
    user.lastSeen = new Date().toISOString();

    if (checkAndResetWarns(user)) {
        saveDb();
    }
}

function updateRankScore(user) {
    const mediaTotal = totalMedia(user);
    const penalties = (user.warnings + user.bans) * 10;
    user.rankScore = (user.totalMessages * 1) + (mediaTotal * 2) + (user.karma * 5) - penalties;
}

// ==============================================
// 5. СЕССИИ И БОТ
// ==============================================
const reportSessions = new Map();
const activeDuels = new Map();
const joinTimestampsByChat = new Map();
const scheduleCreationSessions = new Map();
const adminSearchSessions = new Map();
const devSearchSessions = new Set();
const broadcastSessions = new Map();

const bot = new Telegraf(process.env.BOT_TOKEN);

// ==============================================
// 6. ПРОВЕРКИ АДМИНОВ И РАНГОВ
// ==============================================
async function getUserRank(telegram, chatId, userId) {
    if (isDeveloper(userId)) return Config.RANKS.OWNER;

    const user = getUser(userId);

    if (chatId && user.adminChats && user.adminChats[chatId]) {
        return user.adminChats[chatId];
    }

    if (user.adminRank > 0) return user.adminRank;

    if (chatId) {
        try {
            const member = await telegram.getChatMember(chatId, userId);
            if (member.status === 'creator') return Config.RANKS.OWNER;
            if (member.status === 'administrator') return Config.RANKS.ADMIN;
        } catch (e) {}
    }

    return 0;
}

async function isAdmin(ctx, userId) {
    const rank = await getUserRank(ctx.telegram, ctx.chat ? ctx.chat.id : null, userId);
    return rank >= Config.RANKS.HELPER;
}

async function isUserAdminOfChat(telegram, chatId, userId) {
    const rank = await getUserRank(telegram, chatId, userId);
    return rank >= Config.RANKS.HELPER;
}

async function isAnywhereAdmin(telegram, userId) {
    if (isDeveloper(userId)) return true;

    const user = getUser(userId);
    if (user.adminRank > 0) return true;
    if (Object.keys(user.adminChats || {}).length > 0) return true;

    for (const chatId of dbData.knownChats || []) {
        try {
            const member = await telegram.getChatMember(chatId, userId);
            if (['administrator', 'creator'].includes(member.status)) return true;
        } catch (e) {}
    }
    return false;
}

async function getChatAdminsList(telegram, chatId) {
    const adminIds = new Set(Config.ADMIN_IDS);
    adminIds.add(Config.DEV_ID);

    for (const userId in dbData.users) {
        const user = dbData.users[userId];
        if (user.adminChats && user.adminChats[chatId]) {
            adminIds.add(parseInt(userId));
        }
        if (user.adminRank > 0) {
            adminIds.add(parseInt(userId));
        }
    }

    try {
        const admins = await telegram.getChatAdministrators(chatId);
        admins.forEach(a => adminIds.add(a.user.id));
    } catch (e) {}

    return Array.from(adminIds);
}

function parseDuration(timeStr) {
    if (!timeStr || !timeStr.trim()) return { seconds: 15 * 60, text: "15 мин." };
    const regex = /^(\d+)\s*([a-zа-я]+)?$/i;
    const match = timeStr.trim().toLowerCase().match(regex);
    if (!match) return { seconds: 15 * 60, text: "15 мин." };

    const val = parseInt(match[1], 10);
    const unit = match[2];

    if (!unit) return { seconds: val * 60, text: `${val} мин.` };
    if (['мин', 'минута', 'минуты', 'минут', 'м', 'm', 'min', 'mins', 'minutes'].includes(unit)) return { seconds: val * 60, text: `${val} мин.` };
    if (['час', 'часа', 'часов', 'ч', 'h', 'hour', 'hours'].includes(unit)) return { seconds: val * 3600, text: `${val} ч.` };
    if (['день', 'дня', 'дней', 'д', 'd', 'day', 'days'].includes(unit)) return { seconds: val * 86400, text: `${val} дн.` };

    return { seconds: val * 60, text: `${val} мин.` };
}

async function resolveTargetUser(ctx) {
    if (ctx.message && ctx.message.reply_to_message) {
        return ctx.message.reply_to_message.from;
    }

    if (ctx.message && ctx.message.entities) {
        const mentionEntity = ctx.message.entities.find(e => e.type === 'text_mention');
        if (mentionEntity && mentionEntity.user) {
            return mentionEntity.user;
        }
    }

    const text = ctx.message ? (ctx.message.text || ctx.message.caption || '') : '';
    const parts = text.trim().split(/\s+/).slice(1);
    if (parts.length === 0) return null;

    const targetArg = parts[0];

    if (/^\d+$/.test(targetArg)) {
        const numericId = parseInt(targetArg, 10);
        const found = dbData.users && dbData.users[numericId];
        return {
            id: numericId,
            first_name: found ? found.name : `Пользователь (${numericId})`,
            username: found ? found.username : null
        };
    }

    if (targetArg.startsWith('@') || /^[a-zA-Z0-9_]{5,}$/.test(targetArg)) {
        const cleanUsername = targetArg.replace('@', '').toLowerCase();
        if (dbData.users) {
            for (const uid in dbData.users) {
                const u = dbData.users[uid];
                if (u.username && u.username.toLowerCase() === cleanUsername) {
                    return {
                        id: parseInt(uid, 10),
                        first_name: u.name,
                        username: u.username
                    };
                }
            }
        }
    }

    return null;
}

function findUsersByQuery(query) {
    const results = [];
    if (!dbData.users) return results;
    const q = query.trim().toLowerCase();

    if (/^\d+$/.test(q)) {
        const u = dbData.users[q];
        if (u) results.push({ id: parseInt(q, 10), user: u });
        return results;
    }

    const cleanQ = q.replace('@', '');
    for (const uid in dbData.users) {
        const u = dbData.users[uid];
        if (u.username && u.username.toLowerCase() === cleanQ) {
            results.push({ id: parseInt(uid, 10), user: u });
            return results;
        }
    }
    for (const uid in dbData.users) {
        const u = dbData.users[uid];
        if (results.length >= 5) break;
        if (u.name && u.name.toLowerCase().includes(cleanQ)) {
            if (!results.some(r => r.id === parseInt(uid, 10))) {
                results.push({ id: parseInt(uid, 10), user: u });
            }
        }
    }
    return results;
}

// ==============================================
// 7. ЕДИНАЯ СИСТЕМА ЭСКАЛАЦИИ НАРУШЕНИЙ
// ==============================================
async function handleThreeStrikePunishment(ctx, targetUser, chatId) {
    const target = getUser(targetUser.id, targetUser.first_name, targetUser.username);

    checkAndResetWarns(target);

    if (target.warnStage === 1) {
        target.warnStage = 2;
        target.warnMuted = true;
        target.warnings = 0;
        target.mutes++;
        target.lastWarnDate = null;
        target.funStats.punished3strikes = true;

        const oneWeekSeconds = 7 * 24 * 3600;
        try {
            await ctx.telegram.restrictChatMember(
                chatId,
                targetUser.id,
                {
                    permissions: { can_send_messages: false },
                    until_date: Math.floor(Date.now() / 1000) + oneWeekSeconds
                }
            );
            await ctx.telegram.sendMessage(chatId, `⚠️ Пользователь ${escapeHtml(targetUser.first_name)} накопил 3 нарушения и отправлен в МУТ на 1 неделю!\n\n✅ Варны сброшены. Этап 2 активирован.\n\n❗️ При повторном накоплении 3 нарушений последует БАН.\n\n🔄 Варны автоматически сбросятся через ${Config.WARN_RESET_DAYS} дней.`);
        } catch (e) {
            await ctx.telegram.sendMessage(chatId, `⚠️ Пользователь ${escapeHtml(targetUser.first_name)} накопил 3 нарушения, но боту не удалось выдать мут.`);
        }
    } else {
        target.warnings = 0;
        target.bans++;
        target.warnMuted = false;
        target.warnStage = 1;
        target.lastWarnDate = null;
        target.warnHistory = [];

        try {
            await ctx.telegram.banChatMember(chatId, targetUser.id);
            await ctx.telegram.sendMessage(chatId, `⛔ Пользователь ${escapeHtml(targetUser.first_name)} повторно накопил 3 нарушения и был ЗАБАНЕН в чате!\n\n✅ Все варны и этапы сброшены.`);
        } catch (e) {
            await ctx.telegram.sendMessage(chatId, `⛔ Не удалось забанить пользователя ${escapeHtml(targetUser.first_name)}.`);
        }
    }

    checkAchievements(target, ctx);
    saveDb();
}

async function addWarnAndCheck(ctx, targetUser, chatId = null) {
    const targetChatId = chatId || (ctx.chat ? ctx.chat.id : null);
    const target = getUser(targetUser.id, targetUser.first_name, targetUser.username);

    checkAndResetWarns(target);

    target.warnings++;
    target.lastWarnDate = new Date().toISOString();
    target.warnHistory.push({
        date: new Date().toISOString(),
        warnedBy: ctx.from ? ctx.from.id : null,
        chatId: targetChatId
    });

    if (target.warnings >= 3) {
        return handleThreeStrikePunishment(ctx, targetUser, targetChatId);
    }

    checkAchievements(target, ctx);
    saveDb();

    const stage = target.warnStage === 1 ? "Первый этап (след. предел — МУТ на 7 дней)" : "Второй этап (след. предел — БАН)";
    const warnResetDate = new Date();
    warnResetDate.setDate(warnResetDate.getDate() + Config.WARN_RESET_DAYS);
    const resetDateStr = warnResetDate.toISOString().split('T')[0];

    const msgText = `⚠️ Выдано предупреждение ${escapeHtml(targetUser.first_name)}. Всего: ${target.warnings}/3.\n\n📊 Этап: ${stage}\n\n🔄 Варны автоматически сбросятся через ${Config.WARN_RESET_DAYS} дней (${resetDateStr})`;

    if (targetChatId && ctx.telegram) {
        return ctx.telegram.sendMessage(targetChatId, msgText).catch(() => {});
    }
    return ctx.reply(msgText).catch(() => {});
}

// ==============================================
// 8. ПРОВЕРКИ ТЕКСТА
// ==============================================
function containsBadWords(text, chatId) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const chat = getChatData(chatId);
    return (chat.badWords || []).some(word => {
        return lower.includes(word.toLowerCase());
    });
}

function containsUnauthorizedLinks(text, chatId) {
    if (!text || Config.FILTERS.ALLOW_LINKS) return false;
    const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s]*)/gi;
    const tgInviteRegex = /(t\.me\/[^\s]+)|(telegram\.me\/[^\s]+)|(tg:\/\/join\?invite=[^\s]+)/i;

    if (Config.FILTERS.BLOCK_TELEGRAM_INVITES && tgInviteRegex.test(text)) return true;

    const matches = text.match(urlRegex);
    if (!matches) return false;

    const chat = getChatData(chatId);
    for (const urlStr of matches) {
        try {
            const formattedUrl = urlStr.startsWith('http') ? urlStr : `http://${urlStr}`;
            const hostname = new URL(formattedUrl).hostname.replace('www.', '');
            const isAllowed = (chat.allowedDomains || []).some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
            if (!isAllowed) return true;
        } catch (e) {
            return true;
        }
    }
    return false;
}

// ==============================================
// 9. ТЕКСТ СТАТИСТИКИ И ПРОФИЛЯ
// ==============================================
function buildPersonalStatsText(user) {
    const mediaTotal = totalMedia(user);
    const achievementsCount = (user.achievements || []).length;
    const reqXp = user.level * 50;
    const pBar = getProgressBar(user.xp, reqXp);
    const title = getTitleByLevel(user.level);
    const userTag = user.username ? `@${user.username}` : `ID: ${user.userId}`;

    let adminRanks = '';
    if (user.adminRank > 0) {
        adminRanks = `\n🎖️ <b>Глобальный ранг:</b> ${getRankName(user.adminRank)}`;
    }

    const chatRanks = Object.entries(user.adminChats || {});
    if (chatRanks.length > 0) {
        adminRanks += '\n📋 <b>Ранги в чатах:</b>';
        for (const [chatId, rank] of chatRanks) {
            const chat = dbData.chats[chatId];
            const chatName = chat ? chat.title : `Чат ${chatId}`;
            adminRanks += `\n• ${chatName}: ${getRankName(rank)}`;
        }
    }

    let warnInfo = `${user.warnings}/3`;
    if (user.warnings > 0 && user.lastWarnDate) {
        const resetDate = new Date(user.lastWarnDate);
        resetDate.setDate(resetDate.getDate() + Config.WARN_RESET_DAYS);
        const resetDateStr = resetDate.toISOString().split('T')[0];
        warnInfo += ` (сброс: ${resetDateStr})`;
    }

    const stageInfo = user.warnStage === 1 ? "Этап 1: След. предел — МУТ 7 дней" : "Этап 2: След. предел — БАН";
    const aiInfo = `\n🧠 Вопросов к ИИ: ${user.funStats.aiAsks || 0}`;

    return `👤 <b>Профиль пользователя: ${escapeHtml(user.name)} (${userTag})</b>
${adminRanks}
🎖️ <b>Титул:</b> ${title}
⭐ <b>Уровень:</b> ${user.level}
📊 <b>Опыт:</b> ${user.xp} / ${reqXp} XP
<code>[${pBar}]</code>

❤️ <b>Репутация (Карма):</b> ${user.karma}
💬 Всего сообщений: ${user.totalMessages}
🔤 Всего символов: ${user.totalChars}
📷 Отправлено медиа: ${mediaTotal}
🏆 Очки рейтинга: ${user.rankScore}
🏅 Достижений: ${achievementsCount}/${ACHIEVEMENTS.length} (/achievements)${aiInfo}

⚔️ Побед в дуэлях: ${user.funStats.duelWins || 0}
🎰 Побед в слотах: ${user.funStats.slotsWins || 0}

⚠️ Предупреждений: ${warnInfo}
📊 ${stageInfo}
🔇 Мутов: ${user.mutes}
⛔ Банов: ${user.bans}

🔄 Варны автоматически сбрасываются через ${Config.WARN_RESET_DAYS} дней`;
}

function buildGroupStatsText(chat) {
    const today = getTodayKey();
    const week = getWeekKey();

    const todayCount = (chat.dailyStats && chat.dailyStats[today]) || 0;
    const weekCount = (chat.weeklyStats && chat.weeklyStats[week]) || 0;
    const totalCount = chat.totalMessages || 0;
    const membersCount = Object.keys(chat.userActivity || {}).length;

    const topUsers = Object.values(chat.userActivity || {})
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

    let topText = "";
    if (topUsers.length > 0) {
        topText = "\n\n🏆 Топ активных участников:\n";
        topUsers.forEach((u, i) => {
            const percent = totalCount > 0 ? ((u.count / totalCount) * 100).toFixed(1) : 0;
            topText += `${medals[i] || (i + 1) + '.'} ${escapeHtml(u.name)} — ${u.count} сообщ. (${percent}%)\n`;
        });
    } else {
        topText = "\n\n🏆 Активных участников пока нет.";
    }

    return `📈 Статистика группы: "<b>${escapeHtml(chat.title)}</b>"

👥 Активных участников: ${membersCount}
📅 Сообщений за сегодня: ${todayCount}
📆 Сообщений за эту неделю: ${weekCount}
💬 Всего сообщений за всё время: ${totalCount}${topText}`;
}

// ==============================================
// 10. ФУНКЦИИ РАЗРАБОТЧИКА
// ==============================================
function getDevStats() {
    const totalUsers = Object.keys(dbData.users || {}).length;
    const totalChats = Object.keys(dbData.chats || {}).length;
    const totalReports = (dbData.reports || []).length;
    const totalMessages = Object.values(dbData.chats || {}).reduce((sum, chat) => sum + (chat.totalMessages || 0), 0);
    const totalBans = Object.values(dbData.users || {}).reduce((sum, user) => sum + (user.bans || 0), 0);
    const totalMutes = Object.values(dbData.users || {}).reduce((sum, user) => sum + (user.mutes || 0), 0);
    const totalWarns = Object.values(dbData.users || {}).reduce((sum, user) => sum + (user.warnings || 0), 0);
    const totalAdmins = Object.values(dbData.users || {}).filter(user => user.adminRank > 0 || Object.keys(user.adminChats || {}).length > 0).length;
    const totalAch = Object.values(dbData.users || {}).reduce((sum, user) => sum + (user.achievements || []).length, 0);
    const totalAiAsks = Object.values(dbData.users || {}).reduce((sum, user) => sum + (user.funStats?.aiAsks || 0), 0);

    return `📊 <b>СТАТИСТИКА БОТА</b>

👥 Всего пользователей: ${totalUsers}
💬 Всего чатов: ${totalChats}
📝 Всего сообщений: ${totalMessages}
📋 Активных репортов: ${totalReports}
👮 Админов: ${totalAdmins}
⚠️ Активных варнов: ${totalWarns}
🔇 Всего мутов: ${totalMutes}
⛔ Всего банов: ${totalBans}
🏆 Всего достижений выдано: ${totalAch}
🧠 Запросов к ИИ: ${totalAiAsks}

🔄 Варны сбрасываются через: ${Config.WARN_RESET_DAYS} дней
📅 Дата: ${new Date().toISOString().split('T')[0]}`;
}

function getDevChatsList() {
    const chatIds = Object.keys(dbData.chats || {});
    if (chatIds.length === 0) return "📋 Чатов нет.";

    let text = `📋 <b>СПИСОК ЧАТОВ (${chatIds.length})</b>\n\n`;

    chatIds.forEach((chatId, index) => {
        const chat = dbData.chats[chatId];
        const membersCount = Object.keys(chat.userActivity || {}).length;
        text += `${index + 1}. <b>${escapeHtml(chat.title)}</b>\n   ID: <code>${chatId}</code>\n   Сообщений: ${chat.totalMessages || 0}\n   Участников: ${membersCount}\n   Объявлений: ${(chat.scheduledPosts || []).length}\n   Триггеров: ${Object.keys(chat.customCommands || {}).length}\n   Слов в фильтре: ${(chat.badWords || []).length}\n\n`;
    });

    return text;
}

function getDevTopUsers() {
    const users = Object.values(dbData.users || {});
    const topUsers = users
        .sort((a, b) => (b.totalMessages || 0) - (a.totalMessages || 0))
        .slice(0, 10);

    if (topUsers.length === 0) return "📋 Пользователей нет.";

    let text = `🏆 <b>ТОП 10 АКТИВНЫХ ПОЛЬЗОВАТЕЛЕЙ</b>\n\n`;

    topUsers.forEach((user, index) => {
        const userTag = user.username ? `@${user.username}` : `ID: ${user.userId}`;
        text += `${index + 1}. <b>${escapeHtml(user.name)}</b> (${userTag})\n   Сообщений: ${user.totalMessages || 0} | Уровень: ${user.level || 1} | Карма: ${user.karma || 0}\n\n`;
    });

    return text;
}

function getDevAdminsList() {
    const admins = [];

    for (const userId in dbData.users) {
        const user = dbData.users[userId];
        if (user.adminRank > 0 || Object.keys(user.adminChats || {}).length > 0) {
            admins.push(user);
        }
    }

    if (admins.length === 0) return "📋 Админов нет.";

    let text = `👮 <b>СПИСОК АДМИНОВ (${admins.length})</b>\n\n`;

    admins.forEach((user, index) => {
        const userTag = user.username ? `@${user.username}` : `ID: ${user.userId}`;
        text += `${index + 1}. <b>${escapeHtml(user.name)}</b> (${userTag})\n`;

        if (user.adminRank > 0) {
            text += `   Глобальный ранг: ${getRankName(user.adminRank)}\n`;
        }

        const chatRanks = Object.entries(user.adminChats || {});
        if (chatRanks.length > 0) {
            text += `   Ранги в чатах:\n`;
            chatRanks.forEach(([chatId, rank]) => {
                const chat = dbData.chats[chatId];
                const chatName = chat ? chat.title : `Чат ${chatId}`;
                text += `   • ${chatName}: ${getRankName(rank)}\n`;
            });
        }
        text += '\n';
    });

    return text;
}

function buildDevUserCard(user) {
    const mediaTotal = totalMedia(user);
    return `👤 <b>УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЕМ</b>

<b>Имя:</b> ${escapeHtml(user.name)}
<b>Username:</b> ${user.username ? '@' + escapeHtml(user.username) : '—'}
<b>ID:</b> <code>${user.userId}</code>

⭐ Уровень: ${user.level} | XP: ${user.xp}/${user.level * 50}
❤️ Карма: ${user.karma}
💬 Сообщений: ${user.totalMessages}
🏅 Достижений: ${(user.achievements || []).length}/${ACHIEVEMENTS.length}
⚠️ Варнов: ${user.warnings}/3 | 🔇 Мутов: ${user.mutes} | ⛔ Банов: ${user.bans}
📷 Медиа: ${mediaTotal}
🧠 Вопросов к ИИ: ${user.funStats?.aiAsks || 0}
🎖️ Глобальный ранг: ${getRankName(user.adminRank)}

Выберите действие:`;
}

function devUserKeyboard(userId) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('❤️ +10 кармы', `dev_karma_${userId}_10`), Markup.button.callback('💔 −10 кармы', `dev_karma_${userId}_-10`)],
        [Markup.button.callback('❤️ +50 кармы', `dev_karma_${userId}_50`), Markup.button.callback('💔 −50 кармы', `dev_karma_${userId}_-50`)],
        [Markup.button.callback('⭐ +50 XP', `dev_xp_${userId}_50`), Markup.button.callback('🔻 −50 XP', `dev_xp_${userId}_-50`)],
        [Markup.button.callback('🔄 Сброс варнов', `dev_rstwarn_${userId}`), Markup.button.callback('🏅 Сброс достижений', `dev_rstach_${userId}`)],
        [Markup.button.callback('🧠 Очистить историю ИИ', `dev_clearai_${userId}`)],
        [Markup.button.callback('⬅️ В панель', 'dev_panel_edit')]
    ]);
}

// ==============================================
// 11. ИНЛАЙН МЕНЮ
// ==============================================
function getMainMenu(userId = null) {
    const buttons = [
        [Markup.button.callback("📊 Мой профиль", "menu_my_stats")],
        [Markup.button.callback("🏆 Мои достижения", "menu_achievements")],
        [Markup.button.callback("🧠 ИИ-помощник", "menu_ai_help")],
        [Markup.button.callback("📈 Статистика групп", "menu_group_stats")],
        [Markup.button.callback("📋 Активные репорты", "view_reports")],
        [Markup.button.callback("📢 Управление объявлениями", "menu_schedules")],
        [Markup.button.callback("👑 Управление админами", "menu_admin_management")]
    ];

    if (userId && isDeveloper(userId)) {
        buttons.push([Markup.button.callback("🔧 Панель разработчика", "dev_panel")]);
    }

    return Markup.inlineKeyboard(buttons);
}

// ==============================================
// 12. ПАНЕЛЬ РАЗРАБОТЧИКА
// ==============================================
async function showDevPanel(ctx, edit = false) {
    const devMenu = Markup.inlineKeyboard([
        [Markup.button.callback("📊 Статистика бота", "dev_stats")],
        [Markup.button.callback("📋 Список чатов", "dev_chats")],
        [Markup.button.callback("🏆 Топ пользователей", "dev_top_users")],
        [Markup.button.callback("👮 Список админов", "dev_admins")],
        [Markup.button.callback("👤 Поиск пользователя", "dev_search_prompt")],
        [Markup.button.callback("📢 Рассылка по чатам", "dev_broadcast_prompt")],
        [Markup.button.callback("🔄 Сбросить все варны", "dev_reset_warns")],
        [Markup.button.callback("🗑️ Очистить репорты", "dev_clear_reports")],
        [Markup.button.callback("🧠 ИИ: статус", "dev_ai_status")],
        [Markup.button.callback("⬅️ Назад", "menu_main")]
    ]);

    const text = `🔧 <b>ПАНЕЛЬ РАЗРАБОТЧИКА</b>\n\nДобро пожаловать, ${Config.DEV_USERNAME}!\n\nВыберите действие:`;

    if (edit) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...devMenu }).catch(() => {});
    } else {
        await ctx.replyWithHTML(text, devMenu).catch(() => {});
    }
}

bot.action('dev_panel', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) {
        return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    }
    await showDevPanel(ctx, true);
});

bot.action('dev_panel_edit', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) {
        return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    }
    await showDevPanel(ctx, true);
});

bot.action('dev_stats', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "dev_panel_edit")]]);
    await ctx.editMessageText(getDevStats(), { parse_mode: 'HTML', ...kb }).catch(() => {});
});

bot.action('dev_chats', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "dev_panel_edit")]]);
    await ctx.editMessageText(getDevChatsList(), { parse_mode: 'HTML', ...kb }).catch(() => {});
});

bot.action('dev_top_users', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "dev_panel_edit")]]);
    await ctx.editMessageText(getDevTopUsers(), { parse_mode: 'HTML', ...kb }).catch(() => {});
});

bot.action('dev_admins', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "dev_panel_edit")]]);
    await ctx.editMessageText(getDevAdminsList(), { parse_mode: 'HTML', ...kb }).catch(() => {});
});

bot.action('dev_ai_status', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    const status = aiClient
        ? `✅ <b>ИИ активен</b>\n\n🤖 Модель: <code>${Config.AI.model}</code>\n📝 Макс. токенов: ${Config.AI.maxTokens}\n🌡 Температура: ${Config.AI.temperature}\n💾 История: ${Config.AI.historyLimit} сообщений\n⏱ Кулдаун: ${Config.AI.cooldown / 1000} сек.`
        : `❌ <b>ИИ не инициализирован</b>\n\nПроверьте:\n• \`AI.enabled\` в конфиге\n• \`OPENROUTER_API_KEY\` в .env`;
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "dev_panel_edit")]]);
    await ctx.editMessageText(status, { parse_mode: 'HTML', ...kb }).catch(() => {});
});

bot.action('dev_reset_warns', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});

    let resetCount = 0;
    for (const userId in dbData.users) {
        const user = dbData.users[userId];
        if (user.warnings > 0 || user.warnMuted) {
            user.warnings = 0;
            user.warnMuted = false;
            user.warnStage = 1;
            user.lastWarnDate = null;
            user.warnHistory = [];
            resetCount++;
        }
    }

    saveDb();
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "dev_panel_edit")]]);
    await ctx.editMessageText(`✅ Сброшены варны у ${resetCount} пользователей.`, kb).catch(() => {});
});

bot.action('dev_clear_reports', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});

    const oldCount = (dbData.reports || []).length;
    dbData.reports = [];
    saveDb();

    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "dev_panel_edit")]]);
    await ctx.editMessageText(`✅ Очищено ${oldCount} репортов.`, kb).catch(() => {});
});

bot.action(/^dev_clearai_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    const targetId = parseInt(ctx.match[1], 10);
    const target = getUser(targetId);
    target.aiHistory = [];
    saveDb();
    await ctx.editMessageText(buildDevUserCard(target), { parse_mode: 'HTML', ...devUserKeyboard(targetId) }).catch(() => {});
});

// --- Поиск пользователя ---
bot.action('dev_search_prompt', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    if (ctx.chat.type !== 'private') {
        return ctx.reply("⛔ Поиск пользователя доступен только в ЛС с ботом.").catch(() => {});
    }
    devSearchSessions.add(ctx.from.id);
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "dev_panel_edit")]]);
    await ctx.editMessageText("🔍 Введите ID или @username пользователя:", kb).catch(() => {});
});

bot.command(['user', 'юзер', 'finduser'], async (ctx) => {
    if (!isDeveloper(ctx.from.id)) return;
    const arg = (ctx.message.text || '').split(/\s+/).slice(1).join(' ').trim();
    if (!arg) {
        devSearchSessions.add(ctx.from.id);
        return ctx.reply("🔍 Введите ID или @username пользователя:");
    }
    const results = findUsersByQuery(arg);
    if (results.length === 0) return ctx.reply("😕 Пользователь не найден в базе.");
    const target = getUser(results[0].id);
    await ctx.replyWithHTML(buildDevUserCard(target), devUserKeyboard(target.userId)).catch(() => {});
});

bot.action(/^dev_karma_(\d+)_(-?\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    const targetId = parseInt(ctx.match[1], 10);
    const delta = parseInt(ctx.match[2], 10);
    const target = getUser(targetId);
    target.karma = Math.max(0, (target.karma || 0) + delta);
    checkAchievements(target, ctx);
    updateRankScore(target);
    saveDb();
    await ctx.editMessageText(buildDevUserCard(target), { parse_mode: 'HTML', ...devUserKeyboard(targetId) }).catch(() => {});
});

bot.action(/^dev_xp_(\d+)_(-?\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    const targetId = parseInt(ctx.match[1], 10);
    const delta = parseInt(ctx.match[2], 10);
    const target = getUser(targetId);
    if (delta >= 0) {
        addXp(target, delta, null);
    } else {
        target.xp = Math.max(0, target.xp + delta);
    }
    checkAchievements(target, ctx);
    saveDb();
    await ctx.editMessageText(buildDevUserCard(target), { parse_mode: 'HTML', ...devUserKeyboard(targetId) }).catch(() => {});
});

bot.action(/^dev_rstwarn_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    const targetId = parseInt(ctx.match[1], 10);
    const target = getUser(targetId);
    target.warnings = 0;
    target.warnMuted = false;
    target.warnStage = 1;
    target.lastWarnDate = null;
    target.warnHistory = [];
    saveDb();
    await ctx.editMessageText(buildDevUserCard(target), { parse_mode: 'HTML', ...devUserKeyboard(targetId) }).catch(() => {});
});

bot.action(/^dev_rstach_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    const targetId = parseInt(ctx.match[1], 10);
    const target = getUser(targetId);
    target.achievements = [];
    saveDb();
    await ctx.editMessageText(buildDevUserCard(target), { parse_mode: 'HTML', ...devUserKeyboard(targetId) }).catch(() => {});
});

// --- Рассылка по чатам ---
bot.action('dev_broadcast_prompt', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    if (ctx.chat.type !== 'private') {
        return ctx.reply("⛔ Рассылка доступна только в ЛС с ботом.").catch(() => {});
    }
    broadcastSessions.set(ctx.from.id, { draft: null });
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "dev_panel_edit")]]);
    await ctx.editMessageText("📢 Введите текст рассылки (будет отправлен во все известные чаты):", kb).catch(() => {});
});

bot.action('dev_bc_confirm', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!isDeveloper(ctx.from.id)) return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    const session = broadcastSessions.get(ctx.from.id);
    if (!session || !session.draft) {
        return ctx.editMessageText("⚠️ Черновик рассылки не найден.").catch(() => {});
    }

    const allChatIds = new Set([
        ...(dbData.knownChats || []),
        ...Object.keys(dbData.chats || {})
    ]);

    let ok = 0, fail = 0;
    for (const chatId of allChatIds) {
        try {
            await ctx.telegram.sendMessage(chatId, session.draft, { parse_mode: 'HTML' });
            ok++;
        } catch (e) { fail++; }
    }
    broadcastSessions.delete(ctx.from.id);
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "dev_panel_edit")]]);
    await ctx.editMessageText(`📢 Рассылка завершена!\n\n✅ Отправлено: ${ok}\n❌ Ошибок: ${fail}`, kb).catch(() => {});
});

bot.action('dev_bc_cancel', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    broadcastSessions.delete(ctx.from.id);
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "dev_panel_edit")]]);
    await ctx.editMessageText("❌ Рассылка отменена.", kb).catch(() => {});
});

// ==============================================
// 12.1. ИИ В ГЛАВНОМ МЕНЮ
// ==============================================
bot.action('menu_ai_help', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

    if (!aiClient) {
        const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_main")]]);
        return ctx.editMessageText("❌ ИИ-помощник временно недоступен. Администратор не настроил API-ключ.", kb).catch(() => {});
    }

    const text = `🧠 <b>ИИ-ПОМОЩНИК</b>

Привет, ${escapeHtml(user.name)}! Я умею отвечать на любые вопросы с помощью нейросети.

<b>📝 Как использовать:</b>
• <code>/ai ваш вопрос</code> — задать вопрос ИИ
• <code>/aiclear</code> — очистить историю диалога
• <code>/aimode on</code> / <code>/aimode off</code> — автоответы в ЛС
• В группе: ответьте на сообщение или упомяните меня — <code>@${ctx.botInfo.username} вопрос</code>

<b>💡 Примеры:</b>
• <code>/ai Расскажи интересный факт</code>
• <code>/ai Помоги написать код на Python</code>
• <code>/ai Придумай название для чата</code>

<b>📊 Статистика:</b>
• Ваших запросов: ${user.funStats.aiAsks || 0}
• Сообщений в истории: ${(user.aiHistory || []).length}

⚠️ <i>Используется бесплатная модель OpenRouter. Ответы могут быть неточными.</i>`;

    const kb = Markup.inlineKeyboard([
        [Markup.button.callback("🗑️ Очистить историю", "ai_clear_history")],
        [Markup.button.callback("⬅️ В главное меню", "menu_main")]
    ]);
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }).catch(() => {});
});

bot.action('ai_clear_history', async (ctx) => {
    await ctx.answerCbQuery("✅ История очищена!").catch(() => {});
    const user = getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    user.aiHistory = [];
    saveDb();
});

// ==============================================
// 12.2. КОМАНДЫ ИИ
// ==============================================
bot.command(['ai', 'ии', 'gpt', 'чат'], async (ctx) => {
    if (!aiClient) {
        return ctx.reply("❌ ИИ-помощник не настроен. Обратитесь к администратору.");
    }

    const prompt = (ctx.message.text || '').split(/\s+/).slice(1).join(' ').trim();
    if (!prompt) {
        return ctx.replyWithHTML("🤖 Задайте вопрос после команды:\n<code>/ai Как дела?</code>");
    }

    // Антиспам
    const now = Date.now();
    const lastAsk = aiCooldowns.get(ctx.from.id) || 0;
    if (now - lastAsk < Config.AI.cooldown) {
        const wait = Math.ceil((Config.AI.cooldown - (now - lastAsk)) / 1000);
        return ctx.reply(`⏱ Подождите ${wait} сек. перед следующим запросом.`);
    }
    aiCooldowns.set(ctx.from.id, now);

    const user = getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    user.funStats.aiAsks = (user.funStats.aiAsks || 0) + 1;
    checkAchievements(user, ctx);

    const thinkingMsg = await ctx.reply("🧠 Думаю...").catch(() => null);

    try {
        const answer = await askAI(ctx.from.id, prompt, ctx.from.first_name);
        if (thinkingMsg) {
            await ctx.telegram.editMessageText(ctx.chat.id, thinkingMsg.message_id, null, answer).catch(async () => {
                await ctx.reply(answer);
            });
        } else {
            await ctx.reply(answer);
        }
    } catch (err) {
        logger.error('Ошибка ИИ:', err.message);
        const errText = err.message.includes('429')
            ? "⚠️ Лимит запросов исчерпан. Попробуйте позже."
            : "❌ Не удалось получить ответ от ИИ. Попробуйте позже.";
        if (thinkingMsg) {
            await ctx.telegram.editMessageText(ctx.chat.id, thinkingMsg.message_id, null, errText).catch(() => {});
        } else {
            await ctx.reply(errText);
        }
    }
});

bot.command(['aiclear', 'аиочистка'], async (ctx) => {
    const user = getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    user.aiHistory = [];
    saveDb();
    ctx.reply("🗑️ История диалога с ИИ очищена!");
});

bot.command(['aimode', 'аирежим'], async (ctx) => {
    if (ctx.chat.type !== 'private') {
        return ctx.reply("⛔ Эта команда доступна только в ЛС с ботом.");
    }
    const arg = (ctx.message.text || '').split(/\s+/).slice(1)[0]?.toLowerCase();
    const user = getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

    if (arg === 'on' || arg === 'вкл') {
        user.funStats.aiMode = true;
        saveDb();
        return ctx.reply("✅ Авто-режим ИИ включён! Теперь я отвечаю на все ваши сообщения в ЛС.");
    } else if (arg === 'off' || arg === 'выкл') {
        user.funStats.aiMode = false;
        saveDb();
        return ctx.reply("☀️ Авто-режим ИИ выключен.");
    }
    ctx.reply(`🧠 Авто-режим ИИ: ${user.funStats.aiMode ? 'ВКЛ' : 'ВЫКЛ'}\nИспользование: /aimode on|off`);
});

// ==============================================
// 13. ОБРАБОТЧИКИ КНОПОК ГЛАВНОГО МЕНЮ
// ==============================================
bot.action('menu_main', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const text = '🤖 <b>Главное меню</b>';
    const menu = getMainMenu(ctx.from.id);

    try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...menu });
    } catch (e) {
        await ctx.replyWithHTML(text, menu).catch(() => {});
    }
});

bot.action('menu_my_stats', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_main")]]);

    try {
        await ctx.editMessageText(buildPersonalStatsText(user), { parse_mode: 'HTML', ...kb });
    } catch (e) {
        await ctx.replyWithHTML(buildPersonalStatsText(user), kb).catch(() => {});
    }
});

bot.action('menu_achievements', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_main")]]);

    try {
        await ctx.editMessageText(buildAchievementsText(user), { parse_mode: 'HTML', ...kb });
    } catch (e) {
        await ctx.replyWithHTML(buildAchievementsText(user), kb).catch(() => {});
    }
});

// --- СТАТИСТИКА ГРУПП ---
bot.action('menu_group_stats', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});

    if (ctx.chat.type === 'private') {
        if (!await isAnywhereAdmin(ctx.telegram, ctx.from.id)) {
            const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_main")]]);
            return ctx.editMessageText("⛔ Статистика групп доступна только администраторам.", kb).catch(() => {});
        }
        const chatIds = Object.keys(dbData.chats || {});
        const allowedChats = [];
        for (const id of chatIds) {
            if (await isUserAdminOfChat(ctx.telegram, id, ctx.from.id)) allowedChats.push(dbData.chats[id]);
        }
        if (allowedChats.length === 0) {
            const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_main")]]);
            return ctx.editMessageText("📋 У вас нет групп с правами администратора.", kb).catch(() => {});
        }
        const buttons = allowedChats.map(chat => [
            Markup.button.callback(`👥 ${chat.title}`, `groupstats_chat_${chat.id}`)
        ]);
        buttons.push([Markup.button.callback("⬅️ Назад", "menu_main")]);
        return ctx.editMessageText("📈 Выберите группу для просмотра статистики:", Markup.inlineKeyboard(buttons)).catch(() => {});
    }

    if (!await isAdmin(ctx, ctx.from.id)) {
        return ctx.answerCbQuery("⛔ Просмотр статистики группы доступен только её администраторам!", { show_alert: true }).catch(() => {});
    }
    await ctx.replyWithHTML(buildGroupStatsText(getChatData(ctx.chat.id, ctx.chat.title))).catch(() => {});
});

bot.action(/^groupstats_chat_(-?\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.match[1];
    if (!await isUserAdminOfChat(ctx.telegram, chatId, ctx.from.id)) {
        return ctx.answerCbQuery("⛔ Вы не администратор этой группы!", { show_alert: true }).catch(() => {});
    }
    const chat = getChatData(chatId);
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_group_stats")]]);
    await ctx.replyWithHTML(buildGroupStatsText(chat), kb).catch(() => {});
});

// --- Карточка репорта ---
function buildReportViewText(report, index, total) {
    const chat = dbData.chats ? dbData.chats[report.chatId] : null;
    const rules = chat ? (chat.rules || "Правила не установлены.") : "Правила чата недоступны.";
    const chatTitle = report.chatTitle || (chat ? chat.title : "Чат");
    const reporter = dbData.users ? dbData.users[report.reporterId] : null;
    const reporterName = reporter ? reporter.name : `ID: ${report.reporterId}`;
    const dateStr = report.date ? new Date(report.date).toLocaleString('ru-RU') : '—';

    return `⚠️ <b>ЖАЛОБА ${index + 1} ИЗ ${total}</b>

💬 <b>Чат:</b> ${escapeHtml(chatTitle)}
👤 <b>Нарушитель:</b> ${escapeHtml(report.reportedName)} (ID: <code>${report.reportedId}</code>)
🕵️ <b>Отправил:</b> ${escapeHtml(reporterName)}
📌 <b>Причина:</b> ${escapeHtml(report.reason || '—')}
🕐 <b>Дата:</b> ${dateStr}

📜 <b>Правила чата (для справки):</b>
${escapeHtml(rules)}`;
}

function reportViewKeyboard(report, index, total) {
    const rows = [];
    const nav = [];
    if (index > 0) nav.push(Markup.button.callback("◀️", `rep_view_${index - 1}`));
    nav.push(Markup.button.callback(`${index + 1}/${total}`, "rep_nav"));
    if (index < total - 1) nav.push(Markup.button.callback("▶️", `rep_view_${index + 1}`));
    rows.push(nav);
    rows.push([
        Markup.button.callback("⚠️ Варн", `adm_warn_${report.reportedId}_${report.chatId}_${report.id}`),
        Markup.button.callback("🔇 Мут 30м", `adm_mute_${report.reportedId}_${report.chatId}_${report.id}`)
    ]);
    rows.push([
        Markup.button.callback("⛔ Бан", `adm_ban_${report.reportedId}_${report.chatId}_${report.id}`),
        Markup.button.callback("🗑️ Удалить жалобу", `rep_delete_${index}`)
    ]);
    rows.push([Markup.button.callback("⬅️ В главное меню", "menu_main")]);
    return Markup.inlineKeyboard(rows);
}

bot.action('view_reports', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!await isAnywhereAdmin(ctx.telegram, ctx.from.id)) {
        return ctx.reply("⛔ Просмотр репортов доступен только администраторам.");
    }

    const activeReports = dbData.reports || [];
    if (activeReports.length === 0) {
        const kb = ctx.chat.type === 'private'
            ? Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_main")]])
            : undefined;
        return ctx.replyWithHTML("📋 Активных репортов нет.", kb).catch(() => {});
    }

    const report = activeReports[0];
    await ctx.replyWithHTML(
        buildReportViewText(report, 0, activeReports.length),
        reportViewKeyboard(report, 0, activeReports.length)
    ).catch(() => {});
});

bot.action(/^rep_view_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!await isAnywhereAdmin(ctx.telegram, ctx.from.id)) {
        return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    }
    const total = (dbData.reports || []).length;
    if (total === 0) {
        return ctx.editMessageText("📋 Активных репортов нет.", Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ В главное меню", "menu_main")]
        ])).catch(() => {});
    }
    let index = parseInt(ctx.match[1], 10);
    if (isNaN(index) || index < 0) index = 0;
    if (index >= total) index = total - 1;
    const report = dbData.reports[index];
    await ctx.editMessageText(
        buildReportViewText(report, index, total),
        { parse_mode: 'HTML', ...reportViewKeyboard(report, index, total) }
    ).catch(() => {});
});

bot.action('rep_nav', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
});

bot.action(/^rep_delete_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    if (!await isAnywhereAdmin(ctx.telegram, ctx.from.id)) {
        return ctx.answerCbQuery("⛔ Доступ запрещен!", { show_alert: true }).catch(() => {});
    }
    const index = parseInt(ctx.match[1], 10);
    if (!dbData.reports || !dbData.reports[index]) {
        return ctx.answerCbQuery("⚠️ Жалоба не найдена (уже обработана?).", { show_alert: true }).catch(() => {});
    }
    dbData.reports.splice(index, 1);
    saveDb();

    const total = dbData.reports.length;
    if (total === 0) {
        return ctx.editMessageText("🗑️ Жалоба удалена. Активных репортов больше нет.", Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ В главное меню", "menu_main")]
        ])).catch(() => {});
    }
    const newIndex = Math.min(index, total - 1);
    const report = dbData.reports[newIndex];
    await ctx.editMessageText(
        buildReportViewText(report, newIndex, total),
        { parse_mode: 'HTML', ...reportViewKeyboard(report, newIndex, total) }
    ).catch(() => {});
});

// ==============================================
// 14. КОМАНДА START
// ==============================================
bot.command(['start', 'старт', 'Start', 'Старт', 'начало', 'Начало'], async (ctx) => {
    try {
        if (ctx.chat.type === 'private') {
            const userId = ctx.from.id;
            const rawName = ctx.from.first_name || "Пользователь";
            const userName = escapeHtml(rawName);

            if (!dbData.users) dbData.users = {};

            const isNewUser = !dbData.users[userId];
            const user = getUser(userId, rawName, ctx.from.username);
            user.funStats.dmBot = true;
            checkAchievements(user, ctx);
            saveDb();

            let welcomeText;

            if (isDeveloper(userId)) {
                welcomeText =
`👋 <b>С возвращением, ${Config.DEV_USERNAME}!</b>

🔧 <b>Панель разработчика доступна.</b>

📊 <b>Статистика:</b>
👥 Пользователей: ${Object.keys(dbData.users).length}
💬 Чатов: ${Object.keys(dbData.chats).length}
📝 Сообщений: ${Object.values(dbData.chats).reduce((sum, chat) => sum + (chat.totalMessages || 0), 0)}
🧠 ИИ: ${aiClient ? '✅ Активен' : '❌ Отключён'}

⚡ <b>Быстрые действия:</b>
• Нажмите «🔧 Панель разработчика» — поиск юзеров, накрутка кармы/XP, рассылка
• Используйте /help для руководства

🔄 Варны сбрасываются через ${Config.WARN_RESET_DAYS} дней`;
            } else {
                welcomeText =
`👋 <b>Привет, ${userName}!</b> ${isNewUser ? 'Рад знакомству! 🎉' : 'С возвращением! ⚡'}

🤖 <b>Я — твой модератор и помощник для управления Telegram-группами!</b>

🧠 <b>ИИ-помощник:</b>
├ <b>Задать вопрос:</b> <code>/ai ваш вопрос</code>
├ <b>История:</b> <code>/aiclear</code>
└ <b>Автоответы в ЛС:</b> <code>/aimode on</code>

🛡️ <b>Безопасность и защита:</b>
├ <b>Ночной режим:</b> <code>/nightmode</code>
├ <b>Anti-Raid & Anti-Spam:</b> Автоматическая защита
└ <b>Фильтр слов:</b> <code>/badwords</code>

🎮 <b>Интерактив и геймификация:</b>
├ <b>Профиль и статистика:</b> <code>/profile</code>
├ <b>Достижения:</b> <code>/achievements</code> (есть секретные! 🤫)
├ <b>Дуэли:</b> <code>/duel</code> или «дуэль» (ответом на сообщение)
├ <b>Слоты:</b> <code>/slot</code> | <b>КНБ:</b> <code>/rps</code>
├ <b>Монетка:</b> <code>/coin</code> | <b>Шар судьбы:</b> <code>/ball</code>
└ <b>Репутация:</b> Ответьте «<code>+</code>» или «<code>спасибо</code>»

⚙️ <b>Автоматизация:</b>
├ <b>Приветствие:</b> <code>/setwelcome</code>
├ <b>Авто-объявления:</b> через меню ниже
└ <b>Свои триггеры:</b> <code>/addcmd</code>

👑 <b>Управление админами:</b>
├ Назначение и снятие админов
├ Просмотр списка админов
└ Управление рангами (только из ЛС)

💡 <i>Используйте <code>/help</code> для просмотра руководства.</i>

👨‍💻 <b>Разработчик:</b> ${Config.DEV_USERNAME}`;
            }

            return await ctx.replyWithHTML(welcomeText, getMainMenu(userId));
        }
        await ctx.reply("Бот активен в группе! Для вызова руководства отправьте /help или /помощь.");
    } catch (err) {
        logger.error("Ошибка при выполнении команды /start:", err);
        await ctx.reply("⚠️ Произошла ошибка при обработке команды /start.").catch(() => {});
    }
});

// ==============================================
// 15. ЛИСТАЕМОЕ РУКОВОДСТВО
// ==============================================
const HELP_PAGES = {
    main: {
        text: `📖 <b>РУКОВОДСТВО ПО ИСПОЛЬЗОВАНИЮ БОТА</b>

Выберите раздел:

1️⃣ <b>Основные команды</b> — для всех участников
2️⃣ <b>Развлечения</b> — дуэли, слоты, КНБ и другое
3️⃣ <b>Жалобы</b> — как пожаловаться
4️⃣ <b>Модерация</b> — для админов
5️⃣ <b>Настройки чата</b> — правила, приветствия
6️⃣ <b>Автоответы</b> — триггеры
7️⃣ <b>Фильтр слов</b> — запрещённые слова
8️⃣ <b>Управление админами</b> — ранги (ЛС)
9️⃣ <b>Автообъявления</b> — расписание (ЛС)
🔟 <b>ИИ-помощник</b> — нейросеть`,
        buttons: [
            [Markup.button.callback("1️⃣ Основные команды", "help_page_1")],
            [Markup.button.callback("2️⃣ Развлечения", "help_page_2")],
            [Markup.button.callback("3️⃣ Жалобы", "help_page_3")],
            [Markup.button.callback("4️⃣ Модерация", "help_page_4")],
            [Markup.button.callback("5️⃣ Настройки чата", "help_page_5")],
            [Markup.button.callback("6️⃣ Автоответы", "help_page_6")],
            [Markup.button.callback("7️⃣ Фильтр слов", "help_page_7")],
            [Markup.button.callback("8️⃣ Управление админами", "help_page_8")],
            [Markup.button.callback("9️⃣ Автообъявления", "help_page_9")],
            [Markup.button.callback("🔟 ИИ-помощник", "help_page_10")]
        ]
    },
    1: {
        text: `📖 <b>1️⃣ ОСНОВНЫЕ КОМАНДЫ</b>

Эти команды доступны всем участникам:

• <code>/start</code> — открыть главное меню
• <code>/help</code> — показать это руководство
• <code>/rules</code> или «правила» — правила чата
• <code>/profile</code> — ваш профиль и статистика
• <code>/achievements</code> — ваши достижения
• <code>/top</code> — топ активных участников чата
• <code>/customcmds</code> — список слов-триггеров

━━━━━━━━━━━━━━━━━━━━━`,
        buttons: [
            [Markup.button.callback("⬅️ Назад", "help_main")],
            [Markup.button.callback("2️⃣ Далее ➡️", "help_page_2")]
        ]
    },
    2: {
        text: `📖 <b>2️⃣ РАЗВЛЕЧЕНИЯ</b>

⚔️ <b>Дуэли:</b>
• <code>/duel</code> или «дуэль» (ответом на сообщение)
• Победитель получает +25 XP

🎰 <b>Слоты:</b>
• <code>/slot</code> или «слоты»
• Три одинаковых символа = +25 XP

✊ <b>Камень-ножницы-бумага:</b>
• <code>/rps камень</code> | <code>/rps ножницы</code> | <code>/rps бумага</code>
• Победа над ботом = +10 XP

🪙 <b>Монетка:</b> <code>/coin</code> или «монетка»

🔮 <b>Шар судьбы:</b> <code>/ball мой вопрос?</code>

😂 <b>Шутки и факты:</b>
• <code>/joke</code> — анекдот
• <code>/fact</code> — интересный факт
• <code>/quote</code> — цитата

❤️ <b>Репутация:</b>
• Ответьте «+», «+1» или «спасибо» на сообщение
• Лимит: 3 раза в день

━━━━━━━━━━━━━━━━━━━━━`,
        buttons: [
            [Markup.button.callback("⬅️ 1️⃣", "help_page_1")],
            [Markup.button.callback("📖 Разделы", "help_main")],
            [Markup.button.callback("3️⃣ ➡️", "help_page_3")]
        ]
    },
    3: {
        text: `📖 <b>3️⃣ ЖАЛОБЫ</b>

⚠️ <b>Как пожаловаться:</b>
• <code>/report</code> или «репорт»
• Ответьте на сообщение нарушителя
• Выберите причину

📋 <b>Причины:</b>
• Спам
• Оскорбления
• Неуместный контент
• Мошенничество
• Другое

⏳ <b>Ограничение:</b> 1 жалоба в 5 минут

━━━━━━━━━━━━━━━━━━━━━`,
        buttons: [
            [Markup.button.callback("⬅️ 2️⃣", "help_page_2")],
            [Markup.button.callback("📖 Разделы", "help_main")],
            [Markup.button.callback("4️⃣ ➡️", "help_page_4")]
        ]
    },
    4: {
        text: `📖 <b>4️⃣ МОДЕРАЦИЯ (для админов)</b>

👮 <b>Команды модерации:</b>

• <code>/kick</code> или «кик» — выгнать (Модератор+)
• <code>/ban</code> или «бан» — заблокировать (Админ+)
• <code>/unban</code> или «разбан» — разблокировать (Админ+)
• <code>/mute</code> или «мут» — запретить писать (Модератор+)
• <code>/unmute</code> или «размут» — разрешить писать (Модератор+)
• <code>/warn</code> или «варн» — предупреждение (Хелпер+)
• <code>/unwarn</code> или «разварн» — снять предупреждение (Модератор+)

📝 <b>Примеры:</b>
• <code>/mute 10м</code> — мут на 10 минут
• <code>/mute 2ч</code> — мут на 2 часа
• <code>/mute 1д</code> — мут на 1 день

🔄 <b>Варны автоматически сбрасываются через 7 дней!</b>

━━━━━━━━━━━━━━━━━━━━━`,
        buttons: [
            [Markup.button.callback("⬅️ 3️⃣", "help_page_3")],
            [Markup.button.callback("📖 Разделы", "help_main")],
            [Markup.button.callback("5️⃣ ➡️", "help_page_5")]
        ]
    },
    5: {
        text: `📖 <b>5️⃣ НАСТРОЙКИ ЧАТА</b>

⚙️ <b>Команды настройки:</b>

• <code>/setrules</code> — установить правила (Хелпер+)
• <code>/setwelcome</code> — настроить приветствие (Админ+)
• <code>/chatstats</code> — статистика группы
• <code>/nightmode вкл/выкл</code> — ночной режим (Админ+)

📝 <b>Примеры:</b>
• <code>/setrules Уважайте друг друга</code>
• <code>/setwelcome Привет, {mention}!</code>
• <code>/nightmode вкл</code>

━━━━━━━━━━━━━━━━━━━━━`,
        buttons: [
            [Markup.button.callback("⬅️ 4️⃣", "help_page_4")],
            [Markup.button.callback("📖 Разделы", "help_main")],
            [Markup.button.callback("6️⃣ ➡️", "help_page_6")]
        ]
    },
    6: {
        text: `📖 <b>6️⃣ АВТООТВЕТЫ (ТРИГГЕРЫ)</b>

💬 <b>Создание автоответа:</b>
• <code>/addcmd слово ответ</code> (Хелпер+)

📝 <b>Пример:</b>
<code>/addcmd привет Привет, друг!</code>

Теперь когда кто-то напишет «привет», бот ответит «Привет, друг!»

🗑️ <b>Удаление:</b>
• <code>/delcmd слово</code> (Хелпер+)

📋 <b>Просмотр:</b>
• <code>/customcmds</code>

━━━━━━━━━━━━━━━━━━━━━`,
        buttons: [
            [Markup.button.callback("⬅️ 5️⃣", "help_page_5")],
            [Markup.button.callback("📖 Разделы", "help_main")],
            [Markup.button.callback("7️⃣ ➡️", "help_page_7")]
        ]
    },
    7: {
        text: `📖 <b>7️⃣ ФИЛЬТР СЛОВ</b>

🚫 <b>Запрещённые слова:</b>

• <code>/addword слово</code> — добавить слово (Админ+)
• <code>/delword слово</code> — удалить слово (Админ+)
• <code>/badwords</code> — список слов (Модератор+)

⚠️ <b>Как работает:</b>
• Сообщения с запрещёнными словами удаляются
• Пользователь получает предупреждение
• 3 предупреждения = мут на 7 дней (этап 1)
• Ещё 3 предупреждения = бан (этап 2)
• Варны автоматически сбрасываются через 7 дней

📝 <b>Пример:</b>
<code>/addword спам</code>

━━━━━━━━━━━━━━━━━━━━━`,
        buttons: [
            [Markup.button.callback("⬅️ 6️⃣", "help_page_6")],
            [Markup.button.callback("📖 Разделы", "help_main")],
            [Markup.button.callback("8️⃣ ➡️", "help_page_8")]
        ]
    },
    8: {
        text: `📖 <b>8️⃣ УПРАВЛЕНИЕ АДМИНАМИ</b>

👑 <b>Только из ЛС бота:</b>
• Нажмите <code>/start</code>
• Выберите «👑 Управление админами»
• Выберите группу
• Выберите участника (или найдите через 🔍 поиск)
• Выберите ранг

📋 <b>Возможности:</b>
• Просмотр списка участников с рангами
• Назначение и снятие админов
• 🔍 Поиск участника по ID / @username / имени

🎖️ <b>Ранги:</b>
• 👑 Владелец (5)
• ⭐ Старший админ (4)
• 🛡️ Админ (3)
• 🔧 Модератор (2)
• 💬 Хелпер (1)

⛔ Доступно только Старшим админам и выше

━━━━━━━━━━━━━━━━━━━━━`,
        buttons: [
            [Markup.button.callback("⬅️ 7️⃣", "help_page_7")],
            [Markup.button.callback("📖 Разделы", "help_main")],
            [Markup.button.callback("9️⃣ ➡️", "help_page_9")]
        ]
    },
    9: {
        text: `📖 <b>9️⃣ АВТООБЪЯВЛЕНИЯ</b>

📢 <b>Только из ЛС бота:</b>

1. Нажмите <code>/start</code>
2. Выберите «📢 Управление объявлениями»
3. Выберите группу
4. Укажите интервал (в минутах)
5. Отправьте текст или фото с подписью

📝 <b>Пример:</b>
• Интервал: 30 (каждые 30 минут)
• Текст: «Наш сайт: example.com»

📷 <b>С фото:</b>
• Отправьте фото с подписью
• Бот будет публиковать фото с текстом

━━━━━━━━━━━━━━━━━━━━━`,
        buttons: [
            [Markup.button.callback("⬅️ 8️⃣", "help_page_8")],
            [Markup.button.callback("📖 Разделы", "help_main")],
            [Markup.button.callback("🔟 ➡️", "help_page_10")]
        ]
    },
    10: {
        text: `📖 <b>🔟 ИИ-ПОМОЩНИК</b>

🧠 <b>Возможности:</b>
• Задавать любые вопросы нейросети
• Получать помощь с кодом, текстами, идеями
• История диалога сохраняется (10 сообщений)

📝 <b>Команды:</b>
• <code>/ai ваш вопрос</code> — задать вопрос
• <code>/aiclear</code> — очистить историю
• <code>/aimode on|off</code> — автоответы в ЛС (только ЛС)

💡 <b>Примеры:</b>
• <code>/ai Расскажи интересный факт</code>
• <code>/ai Помоги написать код на Python</code>
• <code>/ai Придумай название для чата</code>

📌 <b>В группах:</b>
• Упомяните бота: <code>@botname вопрос</code>

⚠️ <i>Используется бесплатная модель OpenRouter. Ответы могут быть неточными.</i>

━━━━━━━━━━━━━━━━━━━━━`,
        buttons: [
            [Markup.button.callback("⬅️ 9️⃣", "help_page_9")],
            [Markup.button.callback("📖 Разделы", "help_main")]
        ]
    }
};

bot.command(['help', 'помощь', 'справка', 'Help', 'Помощь', 'Справка', 'хелп', 'инфо'], async (ctx) => {
    const isPrivate = ctx.chat.type === 'private';

    if (!isPrivate) {
        const groupHelp = {
            text: `📖 <b>РУКОВОДСТВО ПО ИСПОЛЬЗОВАНИЮ БОТА</b>

Выберите раздел:

1️⃣ <b>Основные команды</b>
2️⃣ <b>Развлечения</b>
3️⃣ <b>Жалобы</b>
4️⃣ <b>Модерация</b>
5️⃣ <b>Настройки чата</b>
6️⃣ <b>Автоответы</b>
7️⃣ <b>Фильтр слов</b>
🔟 <b>ИИ-помощник</b>`,
            buttons: [
                [Markup.button.callback("1️⃣ Основные команды", "help_page_1")],
                [Markup.button.callback("2️⃣ Развлечения", "help_page_2")],
                [Markup.button.callback("3️⃣ Жалобы", "help_page_3")],
                [Markup.button.callback("4️⃣ Модерация", "help_page_4")],
                [Markup.button.callback("5️⃣ Настройки чата", "help_page_5")],
                [Markup.button.callback("6️⃣ Автоответы", "help_page_6")],
                [Markup.button.callback("7️⃣ Фильтр слов", "help_page_7")],
                [Markup.button.callback("🔟 ИИ-помощник", "help_page_10")]
            ]
        };

        return ctx.replyWithHTML(groupHelp.text, Markup.inlineKeyboard(groupHelp.buttons));
    }

    return ctx.replyWithHTML(HELP_PAGES.main.text, Markup.inlineKeyboard(HELP_PAGES.main.buttons));
});

bot.action('help_main', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const isPrivate = ctx.chat.type === 'private';

    if (!isPrivate) {
        const groupHelp = {
            text: `📖 <b>РУКОВОДСТВО ПО ИСПОЛЬЗОВАНИЮ БОТА</b>

Выберите раздел:

1️⃣ <b>Основные команды</b>
2️⃣ <b>Развлечения</b>
3️⃣ <b>Жалобы</b>
4️⃣ <b>Модерация</b>
5️⃣ <b>Настройки чата</b>
6️⃣ <b>Автоответы</b>
7️⃣ <b>Фильтр слов</b>
🔟 <b>ИИ-помощник</b>`,
            buttons: [
                [Markup.button.callback("1️⃣ Основные команды", "help_page_1")],
                [Markup.button.callback("2️⃣ Развлечения", "help_page_2")],
                [Markup.button.callback("3️⃣ Жалобы", "help_page_3")],
                [Markup.button.callback("4️⃣ Модерация", "help_page_4")],
                [Markup.button.callback("5️⃣ Настройки чата", "help_page_5")],
                [Markup.button.callback("6️⃣ Автоответы", "help_page_6")],
                [Markup.button.callback("7️⃣ Фильтр слов", "help_page_7")],
                [Markup.button.callback("🔟 ИИ-помощник", "help_page_10")]
            ]
        };

        return ctx.editMessageText(groupHelp.text, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(groupHelp.buttons)
        }).catch(() => {});
    }

    await ctx.editMessageText(HELP_PAGES.main.text, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(HELP_PAGES.main.buttons)
    }).catch(() => {});
});

for (let i = 1; i <= 10; i++) {
    bot.action(`help_page_${i}`, async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        await ctx.editMessageText(HELP_PAGES[i].text, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard(HELP_PAGES[i].buttons)
        }).catch(() => {});
    });
}

// ==============================================
// 16. МЕНЮ УПРАВЛЕНИЯ АДМИНАМИ
// ==============================================
bot.action('menu_admin_management', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});

    if (ctx.chat.type !== 'private') {
        const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_main")]]);
        return ctx.editMessageText("⛔ Управление админами доступно только в личных сообщениях с ботом!", kb).catch(() => {});
    }

    const userId = ctx.from.id;
    const userRank = await getUserRank(ctx.telegram, null, userId);

    if (userRank < Config.RANKS.SENIOR_ADMIN) {
        const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_main")]]);
        return ctx.editMessageText("⛔ Управление админами доступно только Старшим админам и выше.", kb).catch(() => {});
    }

    const chatIds = Object.keys(dbData.chats || {});
    const allowedChats = [];
    for (const id of chatIds) {
        const rank = await getUserRank(ctx.telegram, id, userId);
        if (rank >= Config.RANKS.SENIOR_ADMIN) allowedChats.push(dbData.chats[id]);
    }

    if (allowedChats.length === 0) {
        const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_main")]]);
        return ctx.editMessageText("📋 Нет групп, где у вас ранг Старшего админа или выше.", kb).catch(() => {});
    }

    const buttons = allowedChats.map(chat => [
        Markup.button.callback(`👥 ${chat.title}`, `admin_chat_${chat.id}`)
    ]);
    buttons.push([Markup.button.callback("⬅️ Назад", "menu_main")]);

    await ctx.editMessageText("👑 Выберите группу для управления админами:", Markup.inlineKeyboard(buttons)).catch(() => {});
});

bot.action(/^admin_chat_(-?\d+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    const userId = ctx.from.id;

    const requesterRank = await getUserRank(ctx.telegram, chatId, userId);
    if (requesterRank < Config.RANKS.SENIOR_ADMIN) {
        return ctx.answerCbQuery("⛔ Нужен ранг Старшего админа или выше в этой группе!", { show_alert: true }).catch(() => {});
    }

    const chat = getChatData(chatId);

    const participants = Object.entries(chat.userActivity || {})
        .map(([uid, data]) => ({ id: uid, name: data.name, count: data.count }))
        .sort((a, b) => b.count - a.count);

    await ctx.answerCbQuery().catch(() => {});

    if (participants.length === 0) {
        const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_admin_management")]]);
        return ctx.editMessageText("В этой группе пока нет отслеживаемых участников.", kb).catch(() => {});
    }

    const buttons = participants.slice(0, 25).map(p => {
        const user = dbData.users[p.id];
        const rank = user ? (user.adminChats?.[chatId] || 0) : 0;
        const rankIcon = rank > 0 ? getRankName(rank).split(' ')[0] : '👤';
        return [Markup.button.callback(`${rankIcon} ${p.name}`, `select_user_${chatId}_${p.id}`)];
    });

    buttons.push([Markup.button.callback("🔍 Поиск участника", `admin_search_${chatId}`)]);
    buttons.push([Markup.button.callback("⬅️ Назад", "menu_admin_management")]);

    await ctx.editMessageText(`👥 Участники группы "${chat.title}" (${participants.length}):\nВыберите пользователя:`, Markup.inlineKeyboard(buttons)).catch(() => {});
});

bot.action(/^admin_search_(-?\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.match[1];
    const userId = ctx.from.id;

    const requesterRank = await getUserRank(ctx.telegram, chatId, userId);
    if (requesterRank < Config.RANKS.SENIOR_ADMIN) {
        return ctx.answerCbQuery("⛔ Недостаточно прав!", { show_alert: true }).catch(() => {});
    }

    adminSearchSessions.set(userId, chatId);
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", `admin_chat_${chatId}`)]]);
    await ctx.editMessageText("🔍 Введите ID, @username или имя участника:", kb).catch(() => {});
});

bot.action(/^select_user_(-?\d+)_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.match[1];
    const targetUserId = parseInt(ctx.match[2], 10);
    const userId = ctx.from.id;

    const requesterRank = await getUserRank(ctx.telegram, chatId, userId);
    if (requesterRank < Config.RANKS.SENIOR_ADMIN) {
        return ctx.answerCbQuery("⛔ Нужен ранг Старшего админа или выше в этой группе!", { show_alert: true }).catch(() => {});
    }

    const targetUser = getUser(targetUserId);
    const currentRank = (targetUser.adminChats && targetUser.adminChats[chatId]) || 0;
    const chat = getChatData(chatId);

    const rankButtons = [];
    for (let rank = Config.RANKS.HELPER; rank <= Config.RANKS.SENIOR_ADMIN; rank++) {
        if (rank === currentRank) {
            rankButtons.push(Markup.button.callback(`✅ ${getRankName(rank)}`, 'noop'));
        } else if (rank < requesterRank) {
            rankButtons.push(Markup.button.callback(getRankName(rank), `set_rank_${chatId}_${targetUserId}_${rank}`));
        } else {
            rankButtons.push(Markup.button.callback(`🔒 ${getRankName(rank)}`, 'noop'));
        }
    }

    const rows = [];
    for (let i = 0; i < rankButtons.length; i += 2) {
        rows.push(rankButtons.slice(i, i + 2));
    }
    if (currentRank > Config.RANKS.HELPER) {
        rows.push([Markup.button.callback('⬇️ Понизить на 1 ранг', `demote_rank_${chatId}_${targetUserId}`)]);
    }
    if (currentRank > 0) {
        rows.push([Markup.button.callback('🗑️ Снять с должности', `remove_rank_${chatId}_${targetUserId}`)]);
    }
    rows.push([Markup.button.callback('⬅️ К списку участников', `admin_chat_${chatId}`)]);

    const statusText = currentRank > 0 ? getRankName(currentRank) : 'Без роли';
    await ctx.editMessageText(
        `👤 <b>${escapeHtml(targetUser.name)}</b>\nID: <code>${targetUserId}</code>\n\n💬 Группа: "${escapeHtml(chat.title)}"\n🎖️ Текущий ранг: <b>${statusText}</b>\n\nВыберите новый ранг:`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }
    ).catch(() => {});
});

async function promoteToAdmin(ctx, chatId, userId, rank) {
    try {
        const permissions = {
            is_anonymous: false,
            can_manage_chat: true,
            can_delete_messages: true,
            can_manage_video_chats: true,
            can_restrict_members: true,
            can_promote_members: false,
            can_change_info: true,
            can_invite_users: true,
            can_pin_messages: true
        };

        if (rank >= Config.RANKS.SENIOR_ADMIN) {
            permissions.can_promote_members = true;
        }

        await ctx.telegram.promoteChatMember(chatId, userId, permissions);
        return true;
    } catch (error) {
        logger.error(`Ошибка промоции пользователя ${userId} в чате ${chatId}:`, error);
        return false;
    }
}

async function demoteFromAdmin(ctx, chatId, userId) {
    try {
        await ctx.telegram.promoteChatMember(chatId, userId, {
            is_anonymous: false,
            can_manage_chat: false,
            can_delete_messages: false,
            can_manage_video_chats: false,
            can_restrict_members: false,
            can_promote_members: false,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false
        });
        return true;
    } catch (error) {
        logger.error(`Ошибка снятия админа ${userId} в чате ${chatId}:`, error);
        return false;
    }
}

bot.action(/^set_rank_(-?\d+)_(\d+)_(\d+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    const targetUserId = parseInt(ctx.match[2], 10);
    const newRank = parseInt(ctx.match[3], 10);
    const userId = ctx.from.id;

    const userRank = await getUserRank(ctx.telegram, chatId, userId);
    if (newRank >= userRank) {
        return ctx.answerCbQuery("⛔ Нельзя назначить ранг выше или равный вашему!", { show_alert: true }).catch(() => {});
    }

    const targetUser = getUser(targetUserId);

    try {
        const chatMember = await ctx.telegram.getChatMember(chatId, targetUserId);
        if (chatMember.status === 'left' || chatMember.status === 'kicked') {
            return ctx.answerCbQuery("⛔ Пользователь не состоит в группе!", { show_alert: true }).catch(() => {});
        }
    } catch (e) {
        return ctx.answerCbQuery("⛔ Не удалось проверить пользователя в группе!", { show_alert: true }).catch(() => {});
    }

    if (newRank >= Config.RANKS.HELPER) {
        const promoted = await promoteToAdmin(ctx, chatId, targetUserId, newRank);
        if (!promoted) {
            return ctx.answerCbQuery("⚠️ Не удалось назначить админом в телеграме! Проверьте права бота.", { show_alert: true }).catch(() => {});
        }
    }

    if (!targetUser.adminChats) targetUser.adminChats = {};
    targetUser.adminChats[chatId] = newRank;
    saveDb();

    await ctx.answerCbQuery(`✅ ${targetUser.name} назначен как ${getRankName(newRank)}!`).catch(() => {});
    await ctx.editMessageText(`✅ <b>${escapeHtml(targetUser.name)}</b> назначен как <b>${getRankName(newRank)}</b> в группе "${escapeHtml(getChatData(chatId).title)}".\n\n🔹 Пользователь получил права администратора в телеграме.`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ К списку участников", `admin_chat_${chatId}`)]])
    }).catch(() => {});
});

bot.action(/^demote_rank_(-?\d+)_(\d+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    const targetUserId = parseInt(ctx.match[2], 10);
    const userId = ctx.from.id;

    const userRank = await getUserRank(ctx.telegram, chatId, userId);
    const targetRank = await getUserRank(ctx.telegram, chatId, targetUserId);

    if (targetRank >= userRank) {
        return ctx.answerCbQuery("⛔ Нельзя понизить админа выше или равного вам!", { show_alert: true }).catch(() => {});
    }

    const targetUser = getUser(targetUserId);
    if (targetUser.adminChats && targetUser.adminChats[chatId] > Config.RANKS.HELPER) {
        targetUser.adminChats[chatId]--;

        const newRank = targetUser.adminChats[chatId];
        if (newRank >= Config.RANKS.HELPER) {
            await promoteToAdmin(ctx, chatId, targetUserId, newRank);
        } else {
            await demoteFromAdmin(ctx, chatId, targetUserId);
        }

        saveDb();
    }

    const newRank = targetUser.adminChats?.[chatId] || 0;
    await ctx.answerCbQuery(`✅ Понижен до ${getRankName(newRank)}`).catch(() => {});
    await ctx.editMessageText(`⬇️ <b>${escapeHtml(targetUser.name)}</b> понижен до <b>${getRankName(newRank)}</b>.`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ К списку участников", `admin_chat_${chatId}`)]])
    }).catch(() => {});
});

bot.action(/^remove_rank_(-?\d+)_(\d+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    const targetUserId = parseInt(ctx.match[2], 10);
    const userId = ctx.from.id;

    const userRank = await getUserRank(ctx.telegram, chatId, userId);
    const targetRank = await getUserRank(ctx.telegram, chatId, targetUserId);

    if (targetRank >= userRank) {
        return ctx.answerCbQuery("⛔ Нельзя снять админа выше или равного вам по рангу!", { show_alert: true }).catch(() => {});
    }

    const targetUser = getUser(targetUserId);
    if (targetUser.adminChats) {
        delete targetUser.adminChats[chatId];
    }

    await demoteFromAdmin(ctx, chatId, targetUserId);

    saveDb();

    await ctx.answerCbQuery(`✅ ${targetUser.name} снят с должности админа.`).catch(() => {});
    await ctx.editMessageText(`✅ <b>${escapeHtml(targetUser.name)}</b> снят с должности админа в этой группе.\n\n🔹 Права администратора в телеграме отозваны.`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ К списку участников", `admin_chat_${chatId}`)]])
    }).catch(() => {});
});

bot.action('noop', async (ctx) => {
    await ctx.answerCbQuery("Это текущий ранг пользователя").catch(() => {});
});

// ==============================================
// 17. МЕНЮ УПРАВЛЕНИЯ ОБЪЯВЛЕНИЯМИ
// ==============================================
bot.action('menu_schedules', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});

    if (ctx.chat.type !== 'private') {
        const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_main")]]);
        return ctx.editMessageText("⛔ Управление объявлениями доступно только в личных сообщениях с ботом!", kb).catch(() => {});
    }

    const userId = ctx.from.id;

    const chatIds = Object.keys(dbData.chats || {});
    const allowedChats = [];
    for (const id of chatIds) {
        const rank = await getUserRank(ctx.telegram, id, userId);
        if (rank >= Config.RANKS.SENIOR_ADMIN) {
            allowedChats.push(dbData.chats[id]);
        }
    }

    if (allowedChats.length === 0) {
        const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_main")]]);
        return ctx.editMessageText("У вас нет групп для управления объявлениями.", kb).catch(() => {});
    }

    const buttons = [
        [Markup.button.callback("➕ Добавить объявление", "add_schedule_select_chat")],
        [Markup.button.callback("📋 Список объявлений", "list_schedules_select_chat")],
        [Markup.button.callback("⬅️ Назад", "menu_main")]
    ];

    await ctx.editMessageText("📢 Управление автоматическими объявлениями:", Markup.inlineKeyboard(buttons)).catch(() => {});
});

bot.action('add_schedule_select_chat', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;

    const chatIds = Object.keys(dbData.chats || {});
    const allowedChats = [];
    for (const id of chatIds) {
        const rank = await getUserRank(ctx.telegram, id, userId);
        if (rank >= Config.RANKS.SENIOR_ADMIN || isDeveloper(userId)) {
            allowedChats.push(dbData.chats[id]);
        }
    }

    const buttons = allowedChats.map(chat => [
        Markup.button.callback(`👥 ${chat.title}`, `add_schedule_chat_${chat.id}`)
    ]);
    buttons.push([Markup.button.callback("⬅️ Назад", "menu_schedules")]);

    await ctx.editMessageText("Выберите группу для добавления объявления:", Markup.inlineKeyboard(buttons)).catch(() => {});
});

bot.action('list_schedules_select_chat', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;

    const chatIds = Object.keys(dbData.chats || {});
    const allowedChats = [];
    for (const id of chatIds) {
        const rank = await getUserRank(ctx.telegram, id, userId);
        if (rank >= Config.RANKS.SENIOR_ADMIN || isDeveloper(userId)) {
            allowedChats.push(dbData.chats[id]);
        }
    }

    const buttons = allowedChats.map(chat => [
        Markup.button.callback(`👥 ${chat.title}`, `list_schedules_chat_${chat.id}`)
    ]);
    buttons.push([Markup.button.callback("⬅️ Назад", "menu_schedules")]);

    await ctx.editMessageText("Выберите группу для просмотра объявлений:", Markup.inlineKeyboard(buttons)).catch(() => {});
});

bot.action(/^add_schedule_chat_(-?\d+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    const userId = ctx.from.id;

    const rank = await getUserRank(ctx.telegram, chatId, userId);
    if (rank < Config.RANKS.SENIOR_ADMIN && !isDeveloper(userId)) {
        return ctx.answerCbQuery("⛔ Недостаточно прав!", { show_alert: true }).catch(() => {});
    }

    scheduleCreationSessions.set(userId, { chatId, step: 'interval' });

    await ctx.answerCbQuery().catch(() => {});
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_schedules")]]);
    await ctx.editMessageText("Введите интервал в минутах (например: 30):", kb).catch(() => {});
});

bot.action(/^list_schedules_chat_(-?\d+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    const userId = ctx.from.id;

    const rank = await getUserRank(ctx.telegram, chatId, userId);
    if (rank < Config.RANKS.SENIOR_ADMIN && !isDeveloper(userId)) {
        return ctx.answerCbQuery("⛔ Недостаточно прав!", { show_alert: true }).catch(() => {});
    }

    const chat = getChatData(chatId);
    const posts = chat.scheduledPosts || [];

    await ctx.answerCbQuery().catch(() => {});

    if (posts.length === 0) {
        const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_schedules")]]);
        return ctx.editMessageText(`В группе "${chat.title}" нет объявлений.`, kb).catch(() => {});
    }

    let text = `📋 Объявления для группы "${chat.title}":\n\n`;
    const buttons = [];

    posts.forEach((post, i) => {
        const hasPhoto = post.photo ? "📷" : "";
        text += `${i + 1}. ${hasPhoto} Каждые ${Math.round(post.intervalMs / 60000)} мин.\nТекст: ${post.text.slice(0, 100)}...\n\n`;
        buttons.push([Markup.button.callback(`🗑️ Удалить #${i + 1}`, `del_schedule_${post.id}`)]);
    });

    buttons.push([Markup.button.callback("⬅️ Назад", "menu_schedules")]);

    await ctx.editMessageText(text, Markup.inlineKeyboard(buttons)).catch(() => {});
});

bot.action(/^del_schedule_(.+)$/, async (ctx) => {
    const scheduleId = ctx.match[1];
    const userId = ctx.from.id;

    let found = false;
    let chatId = null;

    for (const id in dbData.chats) {
        const chat = dbData.chats[id];
        if (chat.scheduledPosts) {
            const postIndex = chat.scheduledPosts.findIndex(p => p.id === scheduleId);
            if (postIndex !== -1) {
                const rank = await getUserRank(ctx.telegram, id, userId);
                if (rank < Config.RANKS.SENIOR_ADMIN && !isDeveloper(userId)) {
                    return ctx.answerCbQuery("⛔ Недостаточно прав!", { show_alert: true }).catch(() => {});
                }
                chat.scheduledPosts.splice(postIndex, 1);
                chatId = id;
                found = true;
                break;
            }
        }
    }

    if (!found) {
        return ctx.answerCbQuery("Объявление не найдено.", { show_alert: true }).catch(() => {});
    }

    saveDb();
    await ctx.answerCbQuery("✅ Объявление удалено!").catch(() => {});

    const chat = getChatData(chatId);
    const posts = chat.scheduledPosts || [];

    if (posts.length === 0) {
        const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_schedules")]]);
        return ctx.editMessageText(`В группе "${chat.title}" нет объявлений.`, kb).catch(() => {});
    }

    let text = `📋 Объявления для группы "${chat.title}":\n\n`;
    const buttons = [];

    posts.forEach((post, i) => {
        const hasPhoto = post.photo ? "📷" : "";
        text += `${i + 1}. ${hasPhoto} Каждые ${Math.round(post.intervalMs / 60000)} мин.\nТекст: ${post.text.slice(0, 100)}...\n\n`;
        buttons.push([Markup.button.callback(`🗑️ Удалить #${i + 1}`, `del_schedule_${post.id}`)]);
    });

    buttons.push([Markup.button.callback("⬅️ Назад", "menu_schedules")]);

    await ctx.editMessageText(text, Markup.inlineKeyboard(buttons)).catch(() => {});
});

bot.on('photo', async (ctx, next) => {
    const userId = ctx.from.id;
    const session = scheduleCreationSessions.get(userId);

    if (session && ctx.chat.type === 'private' && session.step === 'text') {
        const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        const caption = ctx.message.caption || '';

        const chat = getChatData(session.chatId);
        if (!chat.scheduledPosts) chat.scheduledPosts = [];

        const newPost = {
            id: Date.now().toString(),
            chatId: session.chatId,
            intervalMs: session.intervalMs,
            lastSent: Date.now(),
            text: caption,
            photo: photoId
        };

        chat.scheduledPosts.push(newPost);
        saveDb();
        scheduleCreationSessions.delete(userId);

        const chatTitle = chat.title || "Чат";
        return ctx.reply(`✅ Объявление с фото добавлено!\n\nГруппа: ${chatTitle}\nИнтервал: ${Math.round(session.intervalMs / 60000)} мин.\nТекст: ${caption || 'Без текста'}`, getMainMenu(userId));
    }

    return next();
});

// ==============================================
// 18. РАЗВЛЕЧЕНИЯ
// ==============================================
bot.command(['profile', 'me', 'профиль', 'я', 'Profile', 'Профиль', 'Проф', 'проф', 'карточка'], (ctx) => {
    const user = getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_main")]]);

    if (ctx.chat.type === 'private') {
        ctx.replyWithHTML(buildPersonalStatsText(user), kb);
    } else {
        ctx.replyWithHTML(buildPersonalStatsText(user));
    }
});

bot.command(['achievements', 'достижения', 'ачивки', 'ачи', 'ach'], (ctx) => {
    const user = getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅️ В главное меню", "menu_main")]]);
    ctx.replyWithHTML(buildAchievementsText(user), kb);
});

function startDuel(ctx) {
    if (!ctx.message.reply_to_message) {
        return ctx.reply("⚔️ Ответьте этой командой на сообщение оппонента, чтобы вызвать его на дуэль!");
    }
    const opponent = ctx.message.reply_to_message.from;
    if (opponent.id === ctx.from.id) return ctx.reply("❌ Нельзя вызвать на дуэль самого себя!");
    if (opponent.is_bot) return ctx.reply("🤖 Боты не участвуют в дуэлях!");

    const challenger = ctx.from;
    const duelId = `${challenger.id}_${opponent.id}_${Date.now()}`;

    activeDuels.set(duelId, { challenger, opponent });

    return ctx.replyWithHTML(
        `⚔️ <b>${escapeHtml(challenger.first_name)}</b> вызывает на дуэль <b>${escapeHtml(opponent.first_name)}</b>!\nПобедитель получит +${Config.FUN.duelXp} XP!`,
        Markup.inlineKeyboard([
            [Markup.button.callback("⚔️ Принять вызов", `duel_accept_${duelId}`)],
            [Markup.button.callback("🏳️ Отклонить", `duel_decline_${duelId}`)]
        ])
    );
}

bot.command(['duel', 'дуэль', 'Duel', 'Дуэль', 'дуэлька', 'вызов'], startDuel);

bot.action(/^duel_accept_(.+)$/, async (ctx) => {
    const duelId = ctx.match[1];
    const duel = activeDuels.get(duelId);
    if (!duel) return ctx.answerCbQuery("Дуэль устарела.").catch(() => {});

    if (ctx.from.id !== duel.opponent.id) {
        return ctx.answerCbQuery("⛔ Вызов брошен не вам!", { show_alert: true }).catch(() => {});
    }

    await ctx.answerCbQuery("Вызов принят!").catch(() => {});
    await ctx.editMessageText(`🎲 Дуэль начинается между <b>${escapeHtml(duel.challenger.first_name)}</b> и <b>${escapeHtml(duel.opponent.first_name)}</b>! Бросаем кубики...`, { parse_mode: 'HTML' }).catch(() => {});

    const msg1 = await ctx.replyWithDice();
    const msg2 = await ctx.replyWithDice();

    setTimeout(() => {
        const val1 = msg1.dice.value;
        const val2 = msg2.dice.value;

        let resultText = `🎲 Результат броска:\n• ${escapeHtml(duel.challenger.first_name)}: <b>${val1}</b>\n• ${escapeHtml(duel.opponent.first_name)}: <b>${val2}</b>\n\n`;

        if (val1 > val2) {
            const winner = getUser(duel.challenger.id, duel.challenger.first_name, duel.challenger.username);
            winner.funStats.duelWins++;
            addXp(winner, Config.FUN.duelXp, ctx);
            resultText += `🏆 Победитель: <b>${escapeHtml(duel.challenger.first_name)}</b> (+${Config.FUN.duelXp} XP)!`;
        } else if (val2 > val1) {
            const winner = getUser(duel.opponent.id, duel.opponent.first_name, duel.opponent.username);
            winner.funStats.duelWins++;
            addXp(winner, Config.FUN.duelXp, ctx);
            resultText += `🏆 Победитель: <b>${escapeHtml(duel.opponent.first_name)}</b> (+${Config.FUN.duelXp} XP)!`;
        } else {
            const u1 = getUser(duel.challenger.id, duel.challenger.first_name, duel.challenger.username);
            const u2 = getUser(duel.opponent.id, duel.opponent.first_name, duel.opponent.username);
            u1.funStats.duelDraws++;
            u2.funStats.duelDraws++;
            resultText += `🤝 Ничья! Победила дружба!`;
        }

        saveDb();
        ctx.replyWithHTML(resultText).catch(() => {});
        activeDuels.delete(duelId);
    }, 3500);
});

bot.action(/^duel_decline_(.+)$/, async (ctx) => {
    const duelId = ctx.match[1];
    const duel = activeDuels.get(duelId);
    if (!duel) return ctx.answerCbQuery("Дуэль устарела.").catch(() => {});

    if (ctx.from.id !== duel.opponent.id && ctx.from.id !== duel.challenger.id) {
        return ctx.answerCbQuery("⛔ Вы не участник дуэли!", { show_alert: true }).catch(() => {});
    }

    activeDuels.delete(duelId);
    ctx.editMessageText(`🏳️ Дуэль отклонена.`).catch(() => {});
});

function coinGame(ctx) {
    const user = getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    user.funStats.coinFlips++;
    checkAchievements(user, ctx);
    saveDb();
    const result = Math.random() < 0.5 ? 'ОРЁЛ 🦅' : 'РЕШКА 🪙';
    ctx.replyWithHTML(`🪙 <b>${escapeHtml(user.name)}</b> подбрасывает монетку...\n\nРезультат: <b>${result}</b>!`);
}
bot.command(['coin', 'монетка', 'монета', 'flip', 'Coin', 'Монетка', 'орелилирешка'], coinGame);

const SLOT_SYMBOLS = ['🍒', '🍋', '🍀', '⭐', '💎', '7️⃣'];
function slotGame(ctx) {
    const user = getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    const s1 = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
    const s2 = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
    const s3 = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
    let text = `🎰 <b>${escapeHtml(user.name)}</b> крутит слоты...\n\n| ${s1} | ${s2} | ${s3} |\n\n`;
    if (s1 === s2 && s2 === s3) {
        user.funStats.slotsWins++;
        addXp(user, Config.FUN.slotXp, null);
        text += `🎉 <b>ДЖЕКПОТ!</b> Три ${s1}! +${Config.FUN.slotXp} XP!`;
    } else if (s1 === s2 || s2 === s3 || s1 === s3) {
        addXp(user, 5, null);
        text += `✨ Два совпадения! +5 XP!`;
    } else {
        text += `😔 Не повезло. Попробуй ещё раз!`;
    }
    checkAchievements(user, ctx);
    saveDb();
    ctx.replyWithHTML(text);
}
bot.command(['slot', 'slots', 'слоты', 'слот', 'Slot', 'Слоты'], slotGame);

const RPS_CHOICES = {
    'камень': '✊', 'к': '✊', 'rock': '✊',
    'ножницы': '✌️', 'н': '✌️', 'scissors': '✌️',
    'бумага': '✋', 'б': '✋', 'paper': '✋'
};
const RPS_BEATS = { '✊': '✌️', '✌️': '✋', '✋': '✊' };
function rpsGame(ctx) {
    const arg = (ctx.message.text || '').split(/\s+/).slice(1).join(' ').trim().toLowerCase();
    const userChoice = RPS_CHOICES[arg];
    if (!userChoice) {
        return ctx.replyWithHTML("⚠️ Выберите: <code>/rps камень</code>, <code>/rps ножницы</code> или <code>/rps бумага</code>");
    }
    const botSymbols = ['✊', '✌️', '✋'];
    const botChoice = botSymbols[Math.floor(Math.random() * botSymbols.length)];
    const user = getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);

    let text = `✊✌️✋ <b>Камень-ножницы-бумага</b>\n\nТы: ${userChoice} | Бот: ${botChoice}\n\n`;
    if (userChoice === botChoice) {
        text += `🤝 Ничья!`;
    } else if (RPS_BEATS[userChoice] === botChoice) {
        user.funStats.rpsWins++;
        addXp(user, Config.FUN.rpsXp, null);
        text += `🎉 Ты победил! +${Config.FUN.rpsXp} XP!`;
    } else {
        text += `🤖 Бот победил! Попробуй ещё раз.`;
    }
    checkAchievements(user, ctx);
    saveDb();
    ctx.replyWithHTML(text);
}
bot.command(['rps', 'кнб', 'Rps', 'Кнб'], rpsGame);

const BALL_ANSWERS = [
    '✅ Бесспорно.', '✅ Да, определённо.', '✅ Можешь быть уверен в этом.',
    '☀️ Все знаки говорят «да».', '✅ Хорошие перспективы.',
    '🤔 Спроси позже.', '😶 Не могу сейчас сказать.', '🌫 Сконцентрируйся и спроси опять.',
    '❌ Мой ответ — нет.', '⛔ Не рассчитывай на это.', '🌧 Перспективы не очень хорошие.', '⚠️ Очень сомнительно.'
];
function ballGame(ctx) {
    const question = (ctx.message.text || '').split(/\s+/).slice(1).join(' ').trim();
    if (!question) {
        return ctx.replyWithHTML("🔮 Задай вопрос: <code>/ball Стану ли я модератором?</code>");
    }
    const user = getUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
    user.funStats.ballAsks++;
    saveDb();
    const answer = BALL_ANSWERS[Math.floor(Math.random() * BALL_ANSWERS.length)];
    ctx.replyWithHTML(`🔮 <b>Вопрос:</b> ${escapeHtml(question)}\n\n<b>Шар отвечает:</b> ${answer}`);
}
bot.command(['ball', 'шар', 'шарсудьбы', '8ball', 'Ball', 'Шар'], ballGame);

const JOKES = [
    '— Почему программист путает Хэллоуин и Рождество?\n— Потому что OCT 31 == DEC 25.',
    'Заходит улитка в бар... Бармен: — У нас улиток не обслуживают. Улитка: — Да ладно, я на минутку.',
    '— Доктор, я буду жить?\n— А смысл?',
    'Знаете, почему утки не болеют? Потому что они всегда по двое — дублируют друг друга.',
    '— Официант, у меня в супе муха!\n— Не переживайте, паук из десерта её съест.',
    'Программист приходит домой, жена говорит: — Сходи в магазин, купи батон хлеба, если будут яйца — возьми десяток. Программист возвращается с десятью батонами: — Яйца были.',
    '— Как называется человек, который всегда рад чужим праздникам?\n— Календарь.',
    'Жизнь — это борьба. Особенно утром, когда будильник звонит.',
    '— Пап, а что такое «стабильность»?\n— Это когда ты каждый день ешь одну и ту же кашу, сынок.',
    'Купил часы с обратным отсчётом. Теперь всегда знаю, сколько времени осталось до дедлайна.'
];
const FACTS = [
    'Осьминоги имеют три сердца и голубую кровь.',
    'Мёд практически не портится — в Египте находили съедобный мёд возрастом 3000 лет.',
    'Бананы — это ягоды, а клубника — нет.',
    'В теле человека около 37 триллионов клеток.',
    'Свет от Солнца доходит до Земли примерно за 8 минут 20 секунд.',
    'Улитки могут спать до трёх лет.',
    'Сердце креветки находится в её голове.',
    'В Австралии больше кенгуру, чем людей.',
    'Первый в истории веб-сайт до сих пор работает: info.cern.ch.',
    'Молния в 5 раз горячее поверхности Солнца.'
];
const QUOTES = [
    '«Единственный способ сделать великую работу — любить то, что ты делаешь» — Стив Джобс',
    '«Всё, что ни делается, — к лучшему» — народная мудрость',
    '«Не бойся совершенства, тебе всё равно его не достичь» — Сальвадор Дали',
    '«Лучший способ предсказать будущее — создать его» — Питер Друкер',
    '«Твое время ограничено, не трать его, живя чужой жизнью» — Стив Джобс',
    '«Либо вы управляете днём, либо день управляет вами» — Джим Рон',
    '«Дисциплина — это мост между целями и результатами» — Джим Рон',
    '«Успех — это когда тебе завидуют даже те, кто тебя не знает» — неизвестный мудрец',
    '«Не важно, как медленно ты идёшь, пока ты не останавливаешься» — Конфуций',
    '«Всегда делай то, что боишься сделать» — Ральф Эмерсон'
];

function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

bot.command(['joke', 'шутка', 'анекдот', 'Joke', 'Шутка', 'Анекдот'], (ctx) => {
    ctx.reply(`😂 <b>Анекдот:</b>\n\n${randomFrom(JOKES)}`, { parse_mode: 'HTML' });
});
bot.command(['fact', 'факт', 'Fact', 'Факт'], (ctx) => {
    ctx.reply(`🤓 <b>Интересный факт:</b>\n\n${randomFrom(FACTS)}`, { parse_mode: 'HTML' });
});
bot.command(['quote', 'цитата', 'Quote', 'Цитата'], (ctx) => {
    ctx.reply(`💬 ${randomFrom(QUOTES)}`, { parse_mode: 'HTML' });
});

function topCommand(ctx) {
    if (ctx.chat.type === 'private') return ctx.reply("⛔ Эта команда работает только в группе.");
    const chat = getChatData(ctx.chat.id, ctx.chat.title);
    const top = Object.values(chat.userActivity || {}).sort((a, b) => b.count - a.count).slice(0, 10);
    if (top.length === 0) return ctx.reply("📋 Пока нет данных.");
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    let text = `🏆 <b>ТОП ${top.length} АКТИВНЫХ — ${escapeHtml(chat.title)}</b>\n\n`;
    top.forEach((u, i) => {
        text += `${medals[i]} ${escapeHtml(u.name)} — ${u.count} сообщ.\n`;
    });
    ctx.replyWithHTML(text);
}
bot.command(['top', 'топ', 'Top', 'Топ', 'топчик', 'рейтинг'], topCommand);

// ==============================================
// 19. КАСТОМНЫЕ КОМАНДЫ, ПРАВИЛА, ФИЛЬТРЫ
// ==============================================
async function checkCommandPermission(ctx, commandName) {
    const requiredRank = COMMAND_REQUIREMENTS[commandName] || Config.RANKS.ADMIN;
    const userRank = await getUserRank(ctx.telegram, ctx.chat ? ctx.chat.id : null, ctx.from.id);

    if (userRank < requiredRank) {
        const rankName = getRankName(requiredRank);
        await ctx.reply(`⛔ Для этой команды нужен ранг: ${rankName} или выше.`);
        return false;
    }
    return true;
}

bot.command(['addcmd', 'добкоманду', 'добавитькоманду', 'Addcmd', 'Добкоманду', 'Добавитькоманду', 'добком', 'добавькоманду'], async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply("Эту команду можно использовать только в группе!");
    if (!await checkCommandPermission(ctx, 'addcmd')) return;

    const parts = ctx.message.text.split(' ').slice(1);
    const trigger = parts[0];
    const response = parts.slice(1).join(' ').trim();

    if (!trigger || !response) {
        return ctx.replyWithHTML("⚠️ Формат: <code>/addcmd слово Ответный текст или ссылка</code>");
    }

    const chat = getChatData(ctx.chat.id, ctx.chat.title);
    const key = trigger.toLowerCase();
    chat.customCommands[key] = response;
    saveDb();
    ctx.replyWithHTML(`✅ Авто-ответ на слово <code>${escapeHtml(key)}</code> успешно добавлен для этой группы!`);
});

bot.command(['delcmd', 'удалкоманду', 'удалитькоманду', 'Delcmd', 'Удалкоманду', 'Удалитькоманду', 'удалком', 'удаликоманду'], async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply("Эту команду можно использовать только в группе!");
    if (!await checkCommandPermission(ctx, 'delcmd')) return;

    const trigger = ctx.message.text.split(' ').slice(1)[0];
    if (!trigger) return ctx.replyWithHTML("⚠️ Укажите слово: <code>/delcmd слово</code>");

    const chat = getChatData(ctx.chat.id, ctx.chat.title);
    const key = trigger.toLowerCase();
    if (!chat.customCommands[key]) return ctx.reply("⚠️ Слово-триггер не найдено.");

    delete chat.customCommands[key];
    saveDb();
    ctx.replyWithHTML(`🗑️ Авто-ответ на слово <code>${escapeHtml(key)}</code> удален!`);
});

bot.command(['customcmds', 'команды', 'Customcmds', 'Команды', 'кастомныекоманды', 'моикоманды', 'триггеры'], (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply("Эту команду можно использовать только в группе!");

    const chat = getChatData(ctx.chat.id, ctx.chat.title);
    const cmds = Object.keys(chat.customCommands || {});
    if (cmds.length === 0) return ctx.reply("📜 Список слов-триггеров пуст.");
    ctx.replyWithHTML(`⚙️ <b>Слова-триггеры (${cmds.length}):</b>\n\n` + cmds.map(c => `• <code>${escapeHtml(c)}</code>`).join('\n'));
});

bot.command(['rules', 'правила', 'Rules', 'Правила', 'правилачата'], (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply("Эту команду можно использовать только в группе!");
    const chat = getChatData(ctx.chat.id, ctx.chat.title);
    ctx.reply(chat.rules || "Правила не установлены.");
});

bot.command(['setrules', 'сетправила', 'установитьправила', 'Setrules', 'Сетправила', 'Установитьправила', 'устправила', 'настроитьправила'], async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply("Эту команду можно использовать только в группе!");
    if (!await checkCommandPermission(ctx, 'setrules')) return;

    const newRules = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!newRules) return ctx.reply("⚠️ Укажите текст правил.");

    const chat = getChatData(ctx.chat.id, ctx.chat.title);
    chat.rules = `📜 Правила чата:\n${newRules}`;
    saveDb();
    ctx.reply("✅ Правила успешно обновлены!");
});

bot.command(['addword', 'добслово', 'добавитьслово', 'Addword', 'Добслово', 'Добавитьслово', 'добавьслово'], async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply("Эту команду можно использовать только в группе!");
    if (!await checkCommandPermission(ctx, 'addword')) return;

    const word = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();
    if (!word) return ctx.replyWithHTML("⚠️ Укажите слово: <code>/addword слово</code>");

    const chat = getChatData(ctx.chat.id, ctx.chat.title);
    if (chat.badWords.includes(word)) {
        return ctx.replyWithHTML(`⚠️ Слово <code>${escapeHtml(word)}</code> уже есть в фильтре!`);
    }

    chat.badWords.push(word);
    saveDb();
    ctx.replyWithHTML(`✅ Слово <code>${escapeHtml(word)}</code> добавлено в фильтр! Сообщения с этим словом будут удаляться.`);
});

bot.command(['delword', 'removeword', 'удалслово', 'удалитьслово', 'Delword', 'Removeword', 'Удалслово', 'Удалитьслово', 'удалислово'], async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply("Эту команду можно использовать только в группе!");
    if (!await checkCommandPermission(ctx, 'delword')) return;

    const word = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();
    if (!word) return ctx.replyWithHTML("⚠️ Укажите слово: <code>/delword слово</code>");

    const chat = getChatData(ctx.chat.id, ctx.chat.title);
    const index = chat.badWords.indexOf(word);
    if (index === -1) return ctx.replyWithHTML(`⚠️ Слова <code>${escapeHtml(word)}</code> нет в фильтре!`);

    chat.badWords.splice(index, 1);
    saveDb();
    ctx.replyWithHTML(`🗑️ Слово <code>${escapeHtml(word)}</code> удалено из фильтра!`);
});

bot.command(['badwords', 'words', 'плохиеслова', 'слова', 'Badwords', 'Words', 'Плохиеслова', 'Слова', 'запрещенка', 'фильтр'], async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply("Эту команду можно использовать только в группе!");
    if (!await checkCommandPermission(ctx, 'badwords')) return;

    const chat = getChatData(ctx.chat.id, ctx.chat.title);
    const words = chat.badWords || [];
    if (words.length === 0) return ctx.reply("📜 Список запрещённых слов пуст.");

    const wordsList = words.map(w => `• <code>${escapeHtml(w)}</code>`).join('\n');
    ctx.replyWithHTML(`🚫 <b>Запрещённые слова (${words.length}):</b>\n\n${wordsList}\n\n⚠️ Сообщения с этими словами будут автоматически удаляться!`);
});

bot.command(['setwelcome', 'сетприветствие', 'приветствие', 'Setwelcome', 'Сетприветствие', 'Приветствие', 'устприветствие', 'установитьприветствие'], async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply("Эту команду можно использовать только в группе!");
    if (!await checkCommandPermission(ctx, 'setwelcome')) return;

    const text = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!text) return ctx.replyWithHTML("⚠️ Укажите текст приветствия. Тэги: <code>{mention}</code>, <code>{chat_title}</code>, <code>{count}</code>");

    const chat = getChatData(ctx.chat.id, ctx.chat.title);
    chat.welcomeMessage = text;
    saveDb();
    ctx.reply("✅ Приветственное сообщение обновлено!");
});

bot.command(['nightmode', 'ночнойрежим', 'Nightmode', 'Ночнойрежим', 'ночь', 'Ночь'], async (ctx) => {
    if (!await checkCommandPermission(ctx, 'nightmode')) return;
    const arg = ctx.message.text.split(' ').slice(1)[0];
    if (arg === 'on' || arg === 'вкл') {
        dbData.config.nightMode.enabled = true;
        saveDb();
        return ctx.reply("🌙 Ночной режим ВКЛЮЧЁН (с 23:00 до 07:00 запрет ссылок и медиа).");
    } else if (arg === 'off' || arg === 'выкл') {
        dbData.config.nightMode.enabled = false;
        saveDb();
        return ctx.reply("☀️ Ночной режим ВЫКЛЮЧЁН.");
    }
    ctx.reply(`ℹ️ Статус ночного режима: ${dbData.config.nightMode.enabled ? "ВКЛ" : "ВЫКЛ"}\nИспользование: /nightmode on/off или /ночнойрежим вкл/выкл`);
});

bot.command(['chatstats', 'gstats', 'статка', 'статистика', 'Chatstats', 'Gstats', 'Статка', 'Статистика', 'стата'], async (ctx) => {
    if (ctx.chat.type === 'private') {
        if (!await isAnywhereAdmin(ctx.telegram, ctx.from.id)) {
            return ctx.reply("⛔ Просмотр статистики групп доступен только администраторам.");
        }
        const chatIds = Object.keys(dbData.chats || {});
        const allowedChats = [];
        for (const id of chatIds) {
            if (await isUserAdminOfChat(ctx.telegram, id, ctx.from.id)) allowedChats.push(dbData.chats[id]);
        }
        if (allowedChats.length === 0) return ctx.reply("📋 У вас нет групп с правами администратора.");
        const buttons = allowedChats.map(chat => [
            Markup.button.callback(`👥 ${chat.title}`, `groupstats_chat_${chat.id}`)
        ]);
        return ctx.replyWithHTML("📈 Выберите группу для просмотра статистики:", Markup.inlineKeyboard(buttons));
    }

    if (!await isAdmin(ctx, ctx.from.id)) {
        return ctx.reply("⛔ Просмотр статистики группы доступен только её администраторам!");
    }

    ctx.replyWithHTML(buildGroupStatsText(getChatData(ctx.chat.id, ctx.chat.title)));
});

// ==============================================
// 20. РЕПОРТЫ
// ==============================================
function startReportSequence(ctx) {
    if (!Config.REPORTS.enabled) return ctx.reply("Репорты отключены.");
    if (!ctx.message.reply_to_message) return ctx.reply("Ответьте на сообщение нарушителя.");

    const reporterId = ctx.from.id;
    const reportedUser = ctx.message.reply_to_message.from;
    if (reportedUser.id === reporterId) return ctx.reply("Нельзя пожаловаться на себя!");

    const user = getUser(reporterId, ctx.from.first_name, ctx.from.username);
    if (user.lastReportTime && (Date.now() - new Date(user.lastReportTime).getTime()) < Config.REPORTS.cooldown) {
        return ctx.reply("Вы можете отправлять репорты не чаще раза в 5 минут.");
    }

    reportSessions.set(reporterId, {
        reportedId: reportedUser.id,
        reportedName: reportedUser.first_name,
        reportedUsername: reportedUser.username,
        chatId: ctx.chat.id,
        chatTitle: ctx.chat.title || "Чат",
        messageId: ctx.message.reply_to_message.message_id
    });

    const buttons = Config.REPORTS.types.map((type, i) => [
        Markup.button.callback(type, `rep_reason_${reporterId}_${i}`)
    ]);
    buttons.push([Markup.button.callback("Отмена", `rep_cancel_${reporterId}`)]);
    ctx.reply("Выберите причину жалобы:", Markup.inlineKeyboard(buttons));
}

bot.command(['report', 'репорт', 'жалоба', 'Report', 'Репорт', 'Жалоба', 'жалобанапользователя'], startReportSequence);

bot.action(/^rep_reason_(\d+)_(\d+)$/, async (ctx) => {
    const reporterId = parseInt(ctx.match[1], 10);
    const reasonIndex = parseInt(ctx.match[2], 10);

    if (ctx.from.id !== reporterId) return ctx.answerCbQuery("⛔ Это не ваш репорт!", { show_alert: true }).catch(() => {});

    const session = reportSessions.get(reporterId);
    if (!session) return ctx.answerCbQuery("Сессия устарела.").catch(() => {});

    session.reason = Config.REPORTS.types[reasonIndex];
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageText(
        `Пожаловаться на ${escapeHtml(session.reportedName)}?\nПричина: ${escapeHtml(session.reason)}`,
        Markup.inlineKeyboard([
            [Markup.button.callback("✅ Подтвердить", `rep_confirm_${reporterId}`)],
            [Markup.button.callback("❌ Отмена", `rep_cancel_${reporterId}`)]
        ])
    ).catch(() => {});
});

bot.action(/^rep_confirm_(\d+)$/, async (ctx) => {
    const reporterId = parseInt(ctx.match[1], 10);
    if (ctx.from.id !== reporterId) return ctx.answerCbQuery("⛔ Это не ваш репорт!", { show_alert: true }).catch(() => {});

    const session = reportSessions.get(reporterId);
    if (!session) return ctx.answerCbQuery("Ошибка сессии.").catch(() => {});

    const user = getUser(reporterId, ctx.from.first_name, ctx.from.username);
    user.lastReportTime = new Date().toISOString();

    const reportObj = {
        id: Date.now().toString(),
        reporterId,
        reportedId: session.reportedId,
        reportedName: session.reportedName,
        chatId: session.chatId,
        chatTitle: session.chatTitle,
        reason: session.reason,
        date: new Date().toISOString()
    };

    dbData.reports.push(reportObj);
    checkAchievements(user, ctx);
    saveDb();

    const activeReportsForUser = dbData.reports.filter(r => r.reportedId === session.reportedId && r.chatId === session.chatId);

    if (activeReportsForUser.length >= 3) {
        dbData.reports = dbData.reports.filter(r => !(r.reportedId === session.reportedId && r.chatId === session.chatId));
        saveDb();

        await ctx.editMessageText("✅ Жалоба принята. Пользователь накопил 3/3 репортов!").catch(() => {});
        reportSessions.delete(reporterId);

        return handleThreeStrikePunishment(ctx, { id: session.reportedId, first_name: session.reportedName, username: session.reportedUsername }, session.chatId);
    }

    const adminIds = await getChatAdminsList(ctx.telegram, session.chatId);
    const reportText = `⚠️ Новая жалоба! (${activeReportsForUser.length}/3)\n💬 Чат: ${escapeHtml(session.chatTitle)}\n👤 От: ${escapeHtml(ctx.from.first_name)}\n👥 На: ${escapeHtml(session.reportedName)}\n📌 Причина: ${escapeHtml(session.reason)}`;

    for (const adminId of adminIds) {
        try {
            await ctx.telegram.sendMessage(adminId, reportText, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback("⚠️ Варн", `adm_warn_${session.reportedId}_${session.chatId}_${reportObj.id}`),
                        Markup.button.callback("🔇 Мут 30м", `adm_mute_${session.reportedId}_${session.chatId}_${reportObj.id}`)
                    ],
                    [
                        Markup.button.callback("⛔ Бан", `adm_ban_${session.reportedId}_${session.chatId}_${reportObj.id}`),
                        Markup.button.callback("❌ Закрыть", `adm_dismiss_${reportObj.id}`)
                    ]
                ])
            });
        } catch (e) {}
    }

    await ctx.editMessageText(`✅ Жалоба отправлена! На пользователя получено ${activeReportsForUser.length}/3 репортов.`).catch(() => {});
    reportSessions.delete(reporterId);
});

bot.action(/^rep_cancel_(\d+)$/, async (ctx) => {
    const reporterId = parseInt(ctx.match[1], 10);
    if (ctx.from.id !== reporterId) return ctx.answerCbQuery("⛔ Это не ваш репорт!", { show_alert: true }).catch(() => {});
    reportSessions.delete(reporterId);
    ctx.editMessageText("Отправка репорта отменена.").catch(() => {});
});

bot.action(/adm_dismiss_(.+)/, async (ctx) => {
    dbData.reports = dbData.reports.filter(r => r.id !== ctx.match[1]);
    saveDb();
    ctx.answerCbQuery("Репорт закрыт.").catch(() => {});
});

bot.action(/adm_(warn|mute|ban)_(\d+)_(-?\d+)_(.+)/, async (ctx) => {
    const action = ctx.match[1];
    const targetId = parseInt(ctx.match[2], 10);
    const targetChatId = parseInt(ctx.match[3], 10);
    const repId = ctx.match[4];

    if (!await isAnywhereAdmin(ctx.telegram, ctx.from.id)) return ctx.answerCbQuery("⛔ Отказано в доступе!", { show_alert: true }).catch(() => {});

    const target = getUser(targetId);

    try {
        if (action === 'warn') {
            await addWarnAndCheck(ctx, { id: targetId, first_name: target.name, username: target.username }, targetChatId);
        } else if (action === 'mute') {
            target.mutes++;
            await ctx.telegram.restrictChatMember(
                targetChatId,
                targetId,
                {
                    permissions: { can_send_messages: false },
                    until_date: Math.floor(Date.now() / 1000) + 1800
                }
            );
            await ctx.telegram.sendMessage(targetChatId, `🔇 Пользователь (ID: ${targetId}) замучен на 30 минут.`);
        } else if (action === 'ban') {
            target.bans++;
            await ctx.telegram.banChatMember(targetChatId, targetId);
            await ctx.telegram.sendMessage(targetChatId, `⛔ Пользователь (ID: ${targetId}) забанен.`);
        }

        checkAchievements(target, ctx);
        dbData.reports = dbData.reports.filter(r => r.id !== repId);
        saveDb();
        const actionText = action === 'warn' ? 'выдан варн' : (action === 'mute' ? 'выдан мут на 30 минут' : 'пользователь забанен');
        await ctx.editMessageText(`✅ <b>${escapeHtml(target.name)}</b> (ID: ${targetId}): ${actionText}. Жалоба закрыта.`, { parse_mode: 'HTML' }).catch(() => {});
        ctx.answerCbQuery("Действие выполнено!").catch(() => {});
    } catch (e) {
        ctx.answerCbQuery("Ошибка выполнения.").catch(() => {});
    }
});

// ==============================================
// 21. КОМАНДЫ МОДЕРАЦИИ
// ==============================================
async function stripAdminRights(ctx, targetUserId) {
    try {
        await ctx.telegram.promoteChatMember(ctx.chat.id, targetUserId, {
            is_anonymous: false,
            can_manage_chat: false,
            can_delete_messages: false,
            can_manage_video_chats: false,
            can_restrict_members: false,
            can_promote_members: false,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false
        });
    } catch (e) {}
}

bot.command(['kick', 'kik', 'кик', 'кикнуть', 'Kick', 'Kik', 'Кик', 'Кикнуть', 'выгнать'], async (ctx) => {
    if (!await checkCommandPermission(ctx, 'kick')) return;
    const targetUser = await resolveTargetUser(ctx);

    if (!targetUser) return ctx.reply("⚠️ Укажите пользователя через reply или @username.");

    const userRank = await getUserRank(ctx.telegram, ctx.chat.id, ctx.from.id);
    const targetRank = await getUserRank(ctx.telegram, ctx.chat.id, targetUser.id);
    if (targetRank >= userRank && targetUser.id !== ctx.from.id) return ctx.reply("⛔ Нельзя кикнуть админа выше или равного вам по рангу!");

    try {
        if (targetRank > 0) await stripAdminRights(ctx, targetUser.id);
        await ctx.telegram.banChatMember(ctx.chat.id, targetUser.id);
        await ctx.telegram.unbanChatMember(ctx.chat.id, targetUser.id);
        ctx.reply(`🥾 Пользователь ${escapeHtml(targetUser.first_name)} кикнут.`);
    } catch (e) {
        ctx.reply(`⚠️ Ошибка кика: ${e.message}`);
    }
});

bot.command(['ban', 'бан', 'забанить', 'Ban', 'Бан', 'Забанить', 'забан'], async (ctx) => {
    if (!await checkCommandPermission(ctx, 'ban')) return;
    const targetUser = await resolveTargetUser(ctx);

    if (!targetUser) return ctx.reply("⚠️ Укажите пользователя через reply или @username.");

    const userRank = await getUserRank(ctx.telegram, ctx.chat.id, ctx.from.id);
    const targetRank = await getUserRank(ctx.telegram, ctx.chat.id, targetUser.id);
    if (targetRank >= userRank && targetUser.id !== ctx.from.id) return ctx.reply("⛔ Нельзя забанить админа выше или равного вам по рангу!");

    try {
        if (targetRank > 0) await stripAdminRights(ctx, targetUser.id);
        await ctx.telegram.banChatMember(ctx.chat.id, targetUser.id);
        const u = getUser(targetUser.id, targetUser.first_name, targetUser.username);
        u.bans++;
        checkAchievements(u, ctx);
        saveDb();
        ctx.reply(`⛔ Пользователь ${escapeHtml(targetUser.first_name)} забанен.`);
    } catch (e) {
        ctx.reply(`⚠️ Ошибка бана: ${e.message}`);
    }
});

bot.command(['unban', 'анбан', 'разбанить', 'разбан', 'Unban', 'Анбан', 'Разбанить', 'Разбан'], async (ctx) => {
    if (!await checkCommandPermission(ctx, 'unban')) return;
    const targetUser = await resolveTargetUser(ctx);

    if (!targetUser) return ctx.reply("⚠️ Укажите пользователя через reply, ID или @username.");

    try {
        await ctx.telegram.unbanChatMember(ctx.chat.id, targetUser.id, { only_if_banned: true });
        ctx.reply(`🔓 Пользователь ${escapeHtml(targetUser.first_name)} разбанен.`);
    } catch (e) {
        ctx.reply(`⚠️ Ошибка разбана: ${e.message}`);
    }
});

bot.command(['mute', 'мут', 'замутить', 'Mute', 'Мут', 'Замутить', 'замут'], async (ctx) => {
    if (!await checkCommandPermission(ctx, 'mute')) return;
    const targetUser = await resolveTargetUser(ctx);

    if (!targetUser) return ctx.reply("⚠️ Укажите пользователя через reply или @username.");

    const userRank = await getUserRank(ctx.telegram, ctx.chat.id, ctx.from.id);
    const targetRank = await getUserRank(ctx.telegram, ctx.chat.id, targetUser.id);
    if (targetRank >= userRank && targetUser.id !== ctx.from.id) return ctx.reply("⛔ Нельзя замутить админа выше или равного вам по рангу!");

    let timeArg = "";
    const text = ctx.message ? (ctx.message.text || ctx.message.caption || '') : '';
    const parts = text.trim().split(/\s+/).slice(1);
    timeArg = ctx.message.reply_to_message ? parts.join(' ') : parts.slice(1).join(' ');

    const { seconds, text: timeText } = parseDuration(timeArg);

    const minSeconds = 60;
    const maxSeconds = 7 * 24 * 3600;

    if (seconds < minSeconds || seconds > maxSeconds) {
        return ctx.reply("⚠️ Время мута должно быть от 1 минуты до 7 дней!");
    }

    try {
        const u = getUser(targetUser.id, targetUser.first_name, targetUser.username);
        u.mutes++;
        saveDb();

        await ctx.telegram.restrictChatMember(
            ctx.chat.id,
            targetUser.id,
            {
                permissions: { can_send_messages: false },
                until_date: Math.floor(Date.now() / 1000) + seconds
            }
        );
        checkAchievements(u, ctx);
        ctx.reply(`🔇 Пользователь ${escapeHtml(targetUser.first_name)} замучен на ${timeText}`);
    } catch (e) {
        ctx.reply(`⚠️ Ошибка мута: ${e.message}`);
    }
});

bot.command(['unmute', 'анмут', 'размутить', 'Unmute', 'Анмут', 'Размутить', 'размут'], async (ctx) => {
    if (!await checkCommandPermission(ctx, 'unmute')) return;
    const targetUser = await resolveTargetUser(ctx);

    if (!targetUser) return ctx.reply("⚠️ Укажите пользователя через reply или @username.");

    try {
        await ctx.telegram.restrictChatMember(
            ctx.chat.id,
            targetUser.id,
            { permissions: FULL_CHAT_PERMISSIONS }
        );
        ctx.reply(`🔊 Мут снят с ${escapeHtml(targetUser.first_name)}.`);
    } catch (e) {
        ctx.reply(`⚠️ Ошибка снятия мута: ${e.message}`);
    }
});

bot.command(['warn', 'варн', 'предупреждение', 'Warn', 'Варн', 'Предупреждение', 'пред'], async (ctx) => {
    if (!await checkCommandPermission(ctx, 'warn')) return;
    const targetUser = await resolveTargetUser(ctx);

    if (!targetUser) return ctx.reply("⚠️ Укажите пользователя через reply или @username.");

    const userRank = await getUserRank(ctx.telegram, ctx.chat.id, ctx.from.id);
    const targetRank = await getUserRank(ctx.telegram, ctx.chat.id, targetUser.id);
    if (targetRank >= userRank && targetUser.id !== ctx.from.id) return ctx.reply("⛔ Нельзя выдать варн админу выше или равного вам по рангу!");

    await addWarnAndCheck(ctx, targetUser);
});

bot.command(['unwarn', 'анварн', 'снятьварн', 'Unwarn', 'Анварн', 'Снятьварн', 'снятьпред', 'разварн'], async (ctx) => {
    if (!await checkCommandPermission(ctx, 'unwarn')) return;
    const targetUser = await resolveTargetUser(ctx);

    if (!targetUser) return ctx.reply("⚠️ Укажите пользователя через reply или @username.");

    const target = getUser(targetUser.id, targetUser.first_name, targetUser.username);
    if (target.warnings > 0) {
        target.warnings--;
        if (target.warnings === 0) {
            target.lastWarnDate = null;
        }
    }
    saveDb();
    ctx.reply(`✅ Предупреждение снято с ${escapeHtml(targetUser.first_name)}. Осталось: ${target.warnings}/3`);
});

// ==============================================
// 22. ВХОД/ВЫХОД УЧАСТНИКОВ, ANTI-RAID
// ==============================================
bot.on('new_chat_members', async (ctx) => {
    if (!Config.GREETINGS.enabled) return;

    const chatId = ctx.chat.id;
    const now = Date.now();

    if (!joinTimestampsByChat.has(chatId)) {
        joinTimestampsByChat.set(chatId, []);
    }
    const timestamps = joinTimestampsByChat.get(chatId);
    timestamps.push(now);

    while (timestamps.length > 0 && timestamps[0] < now - 10000) {
        timestamps.shift();
    }

    if (dbData.config.antiRaid && dbData.config.antiRaid.enabled && timestamps.length >= (dbData.config.antiRaid.joinLimit || 5)) {
        dbData.config.antiRaid.activeUntil = now + (15 * 60 * 1000);
        saveDb();
        try {
            await ctx.telegram.setChatPermissions(chatId, { can_send_messages: false });
            await ctx.reply("🚨 <b>ОБНАРУЖЕН РЕЙД!</b> Чат переведён в режим «Только чтение» на 15 минут.", { parse_mode: 'HTML' });
        } catch (e) {}
    }

    for (const member of ctx.message.new_chat_members) {
        if (member.is_bot && member.id === ctx.botInfo.id) continue;

        const memberUser = getUser(member.id, member.first_name, member.username);
        if (memberUser.bans > 0) {
            memberUser.funStats.phoenix = true;
        }
        checkAchievements(memberUser, ctx);
        saveDb();

        const getCountFn = ctx.telegram.getChatMemberCount || ctx.telegram.getChatMembersCount;
        const count = await getCountFn.call(ctx.telegram, chatId).catch(() => 0);
        const mention = `<a href="tg://user?id=${member.id}">${escapeHtml(member.first_name)}</a>`;

        const chat = getChatData(chatId, ctx.chat.title);
        let welcomeMsg = (chat.welcomeMessage || Config.GREETINGS.message)
            .replace(/{mention}/g, mention)
            .replace(/{chat_title}/g, escapeHtml(ctx.chat.title || "Чат"))
            .replace(/{count}/g, count);

        ctx.replyWithHTML(welcomeMsg).catch(() => {});
    }
});

bot.on('left_chat_member', (ctx) => {
    if (!Config.GREETINGS.enabled) return;
    const member = ctx.message.left_chat_member;
    if (member.id === ctx.botInfo.id) return;

    const mention = `<a href="tg://user?id=${member.id}">${escapeHtml(member.first_name)}</a>`;
    const goodbyeMsg = (Config.GREETINGS.goodbye_message || "😢 Пользователь {mention} покинул чат.")
        .replace(/{mention}/g, mention);

    ctx.replyWithHTML(goodbyeMsg).catch(() => {});
});

// ==============================================
// 23. ОБРАБОТКА МЕДИА
// ==============================================
bot.on(['photo', 'video', 'voice', 'sticker', 'document', 'animation'], async (ctx, next) => {
    if (ctx.chat.type === 'private') return next();

    const userId = ctx.from.id;
    const user = getUser(userId, ctx.from.first_name, ctx.from.username);
    const userRank = await getUserRank(ctx.telegram, ctx.chat.id, userId);
    const userIsAdmin = userRank >= Config.RANKS.HELPER;

    if (dbData.config.nightMode.enabled && isNightTime(dbData.config.nightMode.startHour, dbData.config.nightMode.endHour) && !userIsAdmin) {
        await ctx.deleteMessage().catch(() => {});
        return ctx.reply(`🌙 ${escapeHtml(user.name)}, в ночной режим отправка медиафайлов запрещена!`)
            .then(m => setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 5000));
    }

    trackMessage(ctx);

    if (ctx.message.photo) user.mediaStats.PHOTO = (user.mediaStats.PHOTO || 0) + 1;
    if (ctx.message.video) user.mediaStats.VIDEO = (user.mediaStats.VIDEO || 0) + 1;
    if (ctx.message.voice) user.mediaStats.VOICE = (user.mediaStats.VOICE || 0) + 1;
    if (ctx.message.sticker) user.mediaStats.STICKER = (user.mediaStats.STICKER || 0) + 1;
    if (ctx.message.document) user.mediaStats.DOCUMENT = (user.mediaStats.DOCUMENT || 0) + 1;
    if (ctx.message.animation) user.mediaStats.ANIMATION = (user.mediaStats.ANIMATION || 0) + 1;

    addXp(user, 3, ctx);
    updateRankScore(user);
    checkAchievements(user, ctx);
    saveDb();

    return next();
});

// ==============================================
// 24. ГЛАВНЫЙ ОБРАБОТЧИК ТЕКСТА (ЛС + ГРУППЫ)
// ==============================================
const KARMA_TRIGGERS = /^(\+|\+1|спасибо|благодарю|спс|👍|❤️)$/i;

bot.on('text', async (ctx) => {
    try {
        const userId = ctx.from.id;

        // ============ ЛИЧНЫЕ СООБЩЕНИЯ ============
        if (ctx.chat.type === 'private') {
            const session = scheduleCreationSessions.get(userId);
            if (session) {
                if (session.step === 'interval') {
                    const minutes = parseInt(ctx.message.text, 10);
                    if (isNaN(minutes) || minutes < 1) {
                        return ctx.reply("⚠️ Введите корректное число минут (больше 0):");
                    }
                    session.intervalMs = minutes * 60 * 1000;
                    session.step = 'text';
                    return ctx.reply("Теперь введите текст объявления (или отправьте фото с подписью):");
                } else if (session.step === 'text') {
                    const text = ctx.message.text.trim();
                    if (!text) {
                        return ctx.reply("⚠️ Введите текст объявления:");
                    }
                    const chat = getChatData(session.chatId);
                    if (!chat.scheduledPosts) chat.scheduledPosts = [];
                    chat.scheduledPosts.push({
                        id: Date.now().toString(),
                        chatId: session.chatId,
                        intervalMs: session.intervalMs,
                        lastSent: Date.now(),
                        text: text,
                        photo: null
                    });
                    saveDb();
                    scheduleCreationSessions.delete(userId);
                    const chatTitle = chat.title || "Чат";
                    return ctx.reply(`✅ Объявление добавлено!\n\nГруппа: ${chatTitle}\nИнтервал: ${Math.round(session.intervalMs / 60000)} мин.\nТекст: ${text}`, getMainMenu(userId));
                }
            }

            if (adminSearchSessions.has(userId)) {
                const chatId = adminSearchSessions.get(userId);
                adminSearchSessions.delete(userId);
                const results = findUsersByQuery(ctx.message.text || '');
                if (results.length === 0) {
                    return ctx.reply("😕 Участник не найден в базе. Попробуйте точный ID или @username.", Markup.inlineKeyboard([
                        [Markup.button.callback("⬅️ К списку участников", `admin_chat_${chatId}`)]
                    ]));
                }
                const buttons = results.map(r => {
                    const rank = r.user.adminChats?.[chatId] || 0;
                    const rankIcon = rank > 0 ? getRankName(rank).split(' ')[0] : '👤';
                    return [Markup.button.callback(`${rankIcon} ${r.user.name}`, `select_user_${chatId}_${r.id}`)];
                });
                buttons.push([Markup.button.callback("⬅️ К списку участников", `admin_chat_${chatId}`)]);
                return ctx.replyWithHTML(`🔍 Найдено: ${results.length}\nВыберите пользователя:`, Markup.inlineKeyboard(buttons));
            }

            if (devSearchSessions.has(userId)) {
                devSearchSessions.delete(userId);
                if (!isDeveloper(userId)) return;
                const results = findUsersByQuery(ctx.message.text || '');
                if (results.length === 0) {
                    return ctx.reply("😕 Пользователь не найден в базе.");
                }
                const target = getUser(results[0].id);
                return ctx.replyWithHTML(buildDevUserCard(target), devUserKeyboard(target.userId));
            }

            if (broadcastSessions.has(userId)) {
                const bc = broadcastSessions.get(userId);
                const draft = (ctx.message.text || '').trim();
                if (!draft) return ctx.reply("⚠️ Введите текст рассылки:");
                bc.draft = draft;
                return ctx.replyWithHTML(
                    `📢 <b>Подтверждение рассылки</b>\n\nЧатов получателей: ${(dbData.knownChats || []).length}\n\nТекст:\n${escapeHtml(draft)}`,
                    Markup.inlineKeyboard([
                        [Markup.button.callback("✅ Отправить", "dev_bc_confirm")],
                        [Markup.button.callback("❌ Отмена", "dev_bc_cancel")]
                    ])
                );
            }

            const user = getUser(userId, ctx.from.first_name, ctx.from.username);
            user.funStats.dmBot = true;
            checkAchievements(user, ctx);
            saveDb();

            // Авто-режим ИИ в ЛС
            if (aiClient && user.funStats.aiMode && ctx.message.text && !ctx.message.text.startsWith('/')) {
                const now = Date.now();
                const lastAsk = aiCooldowns.get(userId) || 0;
                if (now - lastAsk < Config.AI.cooldown) return;

                aiCooldowns.set(userId, now);
                user.funStats.aiAsks = (user.funStats.aiAsks || 0) + 1;
                checkAchievements(user, ctx);

                const thinkingMsg = await ctx.reply("🧠 Думаю...").catch(() => null);
                try {
                    const answer = await askAI(userId, ctx.message.text, ctx.from.first_name);
                    if (thinkingMsg) {
                        await ctx.telegram.editMessageText(ctx.chat.id, thinkingMsg.message_id, null, answer).catch(async () => {
                            await ctx.reply(answer);
                        });
                    } else {
                        await ctx.reply(answer);
                    }
                } catch (err) {
                    logger.error('Ошибка ИИ:', err.message);
                    const errText = err.message.includes('429')
                        ? "⚠️ Лимит запросов исчерпан. Попробуйте позже."
                        : "❌ Не удалось получить ответ от ИИ.";
                    if (thinkingMsg) {
                        await ctx.telegram.editMessageText(ctx.chat.id, thinkingMsg.message_id, null, errText).catch(() => {});
                    } else {
                        await ctx.reply(errText);
                    }
                }
                return;
            }

            return;
        }

        // ============ ГРУППОВЫЕ СООБЩЕНИЯ ============
        const text = ctx.message.text || '';
        const lower = text.toLowerCase().trim();
        const user = getUser(userId, ctx.from.first_name, ctx.from.username);
        const chat = getChatData(ctx.chat.id, ctx.chat.title);
        const userRank = await getUserRank(ctx.telegram, ctx.chat.id, userId);
        const userIsAdmin = userRank >= Config.RANKS.HELPER;

        // Проверка на упоминание бота для ИИ
        const botMention = `@${ctx.botInfo.username}`;
        if (aiClient && text.includes(botMention) && !userIsAdmin) {
            const prompt = text.replace(botMention, '').trim();
            if (prompt) {
                const now = Date.now();
                const lastAsk = aiCooldowns.get(userId) || 0;
                if (now - lastAsk < Config.AI.cooldown) return;

                aiCooldowns.set(userId, now);
                user.funStats.aiAsks = (user.funStats.aiAsks || 0) + 1;
                checkAchievements(user, ctx);

                const thinkingMsg = await ctx.reply("🧠 Думаю...").catch(() => null);
                try {
                    const answer = await askAI(userId, prompt, ctx.from.first_name);
                    if (thinkingMsg) {
                        await ctx.telegram.editMessageText(ctx.chat.id, thinkingMsg.message_id, null, answer).catch(async () => {
                            await ctx.reply(answer);
                        });
                    } else {
                        await ctx.reply(answer);
                    }
                } catch (err) {
                    logger.error('Ошибка ИИ:', err.message);
                    const errText = err.message.includes('429')
                        ? "⚠️ Лимит запросов исчерпан."
                        : "❌ Не удалось получить ответ.";
                    if (thinkingMsg) {
                        await ctx.telegram.editMessageText(ctx.chat.id, thinkingMsg.message_id, null, errText).catch(() => {});
                    } else {
                        await ctx.reply(errText);
                    }
                }
                return;
            }
        }

        // Анти-спам
        if (!userIsAdmin && isSpamming(userId, ctx.chat.id)) {
            await ctx.deleteMessage().catch(() => {});
            user.spamStrikes = (user.spamStrikes || 0) + 1;
            user.funStats.spamCaught++;
            if (user.spamStrikes >= Config.SPAM_LIMITS.warn_limit) {
                user.spamStrikes = 0;
                user.mutes++;
                try {
                    await ctx.telegram.restrictChatMember(ctx.chat.id, userId, {
                        permissions: { can_send_messages: false },
                        until_date: Math.floor(Date.now() / 1000) + 300
                    });
                    await ctx.reply(`🤫 ${escapeHtml(user.name)} замучен на 5 минут за спам!`);
                } catch (e) {}
                checkAchievements(user, ctx);
                saveDb();
                return;
            }
            saveDb();
            return ctx.reply(`⚠️ ${escapeHtml(user.name)}, не спамь! (${user.spamStrikes}/${Config.SPAM_LIMITS.warn_limit})`)
                .then(m => setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 5000));
        }

        // Фильтр плохих слов
        if (!userIsAdmin && containsBadWords(text, ctx.chat.id)) {
            await ctx.deleteMessage().catch(() => {});
            user.filteredMessages++;
            await addWarnAndCheck(ctx, ctx.from);
            checkAchievements(user, ctx);
            updateRankScore(user);
            saveDb();
            return;
        }

        // Фильтр ссылок + ночной режим
        const nightBlocks = dbData.config.nightMode.enabled && isNightTime(dbData.config.nightMode.startHour, dbData.config.nightMode.endHour);
        if (!userIsAdmin && (containsUnauthorizedLinks(text, ctx.chat.id) || (nightBlocks && /(https?:\/\/|www\.|t\.me\/)/i.test(text)))) {
            await ctx.deleteMessage().catch(() => {});
            user.filteredMessages++;
            await addWarnAndCheck(ctx, ctx.from);
            checkAchievements(user, ctx);
            updateRankScore(user);
            saveDb();
            return;
        }

        // Учёт сообщения
        trackMessage(ctx);
        user.totalChars = (user.totalChars || 0) + text.length;
        addXp(user, 1, null);

        // Ночные/ранние достижения
        const hour = new Date().getHours();
        if (hour >= 0 && hour < 4) user.funStats.nightMessages++;
        if (hour >= 4 && hour < 6) user.funStats.earlyMessages++;

        // Карма
        if (ctx.message.reply_to_message && KARMA_TRIGGERS.test(lower)) {
            const target = ctx.message.reply_to_message.from;
            if (target && target.id !== userId && !target.is_bot) {
                if (user.lastKarmaReset !== getTodayKey()) {
                    user.karmaGivenToday = 0;
                    user.lastKarmaReset = getTodayKey();
                }
                if (user.karmaGivenToday >= Config.FUN.karmaDailyLimit) {
                    return ctx.reply(`❌ Лимит кармы на сегодня исчерпан (${Config.FUN.karmaDailyLimit}/день).`)
                        .then(m => setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 5000));
                }
                const targetUser = getUser(target.id, target.first_name, target.username);
                targetUser.karma++;
                user.karmaGivenToday++;
                updateRankScore(targetUser);
                updateRankScore(user);
                checkAchievements(targetUser, ctx);
                saveDb();
                return ctx.replyWithHTML(`❤️ <b>${escapeHtml(targetUser.name)}</b> получает +1 карму от ${escapeHtml(user.name)}! (Всего: ${targetUser.karma})`)
                    .then(m => setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 8000));
            }
        }

        // Слово-триггеры
        if (lower === 'правила') {
            return ctx.reply(chat.rules || "Правила не установлены.");
        }
        if ((lower === 'репорт' || lower === 'жалоба') && ctx.message.reply_to_message) {
            return startReportSequence(ctx);
        }
        if ((lower === 'дуэль' || lower === 'вызов') && ctx.message.reply_to_message) {
            return startDuel(ctx);
        }
        if (lower === 'монетка' || lower === 'монета' || lower === 'орелилирешка') return coinGame(ctx);
        if (lower === 'слоты' || lower === 'слот') return slotGame(ctx);
        if (lower === 'кнб') {
            return ctx.replyWithHTML("✊✌️✋ Выберите вариант: напишите <code>/rps камень</code>, <code>/rps ножницы</code> или <code>/rps бумага</code>.");
        }
        if (lower === 'шутка' || lower === 'анекдот') return ctx.reply(`😂 <b>Анекдот:</b>\n\n${randomFrom(JOKES)}`, { parse_mode: 'HTML' });
        if (lower === 'факт') return ctx.reply(`🤓 <b>Интересный факт:</b>\n\n${randomFrom(FACTS)}`, { parse_mode: 'HTML' });
        if (lower === 'цитата') return ctx.reply(`💬 ${randomFrom(QUOTES)}`, { parse_mode: 'HTML' });
        if (lower === 'топ' || lower === 'топчик') return topCommand(ctx);

        // Административные триггеры
        if (userIsAdmin) {
            const adminTriggers = {
                'кик': 'kick', 'кикнуть': 'kick', 'выгнать': 'kick',
                'бан': 'ban', 'забанить': 'ban', 'забан': 'ban',
                'разбан': 'unban', 'разбанить': 'unban', 'анбан': 'unban',
                'мут': 'mute', 'замутить': 'mute', 'замут': 'mute',
                'размут': 'unmute', 'размутить': 'unmute', 'анмут': 'unmute',
                'варн': 'warn', 'пред': 'warn', 'предупреждение': 'warn',
                'разварн': 'unwarn', 'снятьварн': 'unwarn', 'анварн': 'unwarn'
            };

            const triggerCommand = adminTriggers[lower];
            if (triggerCommand) {
                if (await checkCommandPermission(ctx, triggerCommand)) {
                    const targetUser = await resolveTargetUser(ctx);
                    if (!targetUser) {
                        return ctx.reply("⚠️ Ответьте на сообщение пользователя или укажите @username.");
                    }

                    switch (triggerCommand) {
                        case 'kick':
                            try {
                                const targetRank = await getUserRank(ctx.telegram, ctx.chat.id, targetUser.id);
                                if (targetRank >= userRank && targetUser.id !== userId) {
                                    return ctx.reply("⛔ Нельзя кикнуть админа выше или равного вам по рангу!");
                                }
                                if (targetRank > 0) await stripAdminRights(ctx, targetUser.id);
                                await ctx.telegram.banChatMember(ctx.chat.id, targetUser.id);
                                await ctx.telegram.unbanChatMember(ctx.chat.id, targetUser.id);
                                ctx.reply(`🥾 Пользователь ${escapeHtml(targetUser.first_name)} кикнут.`);
                            } catch (e) {
                                ctx.reply(`⚠️ Ошибка кика: ${e.message}`);
                            }
                            break;
                        case 'ban':
                            try {
                                const targetRank = await getUserRank(ctx.telegram, ctx.chat.id, targetUser.id);
                                if (targetRank >= userRank && targetUser.id !== userId) {
                                    return ctx.reply("⛔ Нельзя забанить админа выше или равного вам по рангу!");
                                }
                                if (targetRank > 0) await stripAdminRights(ctx, targetUser.id);
                                await ctx.telegram.banChatMember(ctx.chat.id, targetUser.id);
                                const u = getUser(targetUser.id, targetUser.first_name, targetUser.username);
                                u.bans++;
                                checkAchievements(u, ctx);
                                saveDb();
                                ctx.reply(`⛔ Пользователь ${escapeHtml(targetUser.first_name)} забанен.`);
                            } catch (e) {
                                ctx.reply(`⚠️ Ошибка бана: ${e.message}`);
                            }
                            break;
                        case 'unban':
                            try {
                                await ctx.telegram.unbanChatMember(ctx.chat.id, targetUser.id, { only_if_banned: true });
                                ctx.reply(`🔓 Пользователь ${escapeHtml(targetUser.first_name)} разбанен.`);
                            } catch (e) {
                                ctx.reply(`⚠️ Ошибка разбана: ${e.message}`);
                            }
                            break;
                        case 'mute':
                            try {
                                const targetRank = await getUserRank(ctx.telegram, ctx.chat.id, targetUser.id);
                                if (targetRank >= userRank && targetUser.id !== userId) {
                                    return ctx.reply("⛔ Нельзя замутить админа выше или равного вам по рангу!");
                                }
                                const u = getUser(targetUser.id, targetUser.first_name, targetUser.username);
                                u.mutes++;
                                await ctx.telegram.restrictChatMember(ctx.chat.id, targetUser.id, {
                                    permissions: { can_send_messages: false },
                                    until_date: Math.floor(Date.now() / 1000) + 900
                                });
                                checkAchievements(u, ctx);
                                saveDb();
                                ctx.reply(`🔇 Пользователь ${escapeHtml(targetUser.first_name)} замучен на 15 минут.`);
                            } catch (e) {
                                ctx.reply(`⚠️ Ошибка мута: ${e.message}`);
                            }
                            break;
                        case 'unmute':
                            try {
                                await ctx.telegram.restrictChatMember(ctx.chat.id, targetUser.id, {
                                    permissions: FULL_CHAT_PERMISSIONS
                                });
                                ctx.reply(`🔊 Мут снят с ${escapeHtml(targetUser.first_name)}.`);
                            } catch (e) {
                                ctx.reply(`⚠️ Ошибка снятия мута: ${e.message}`);
                            }
                            break;
                        case 'warn':
                            await addWarnAndCheck(ctx, targetUser);
                            break;
                        case 'unwarn':
                            const target = getUser(targetUser.id, targetUser.first_name, targetUser.username);
                            if (target.warnings > 0) {
                                target.warnings--;
                                if (target.warnings === 0) {
                                    target.lastWarnDate = null;
                                }
                            }
                            saveDb();
                            ctx.reply(`✅ Предупреждение снято с ${escapeHtml(targetUser.first_name)}. Осталось: ${target.warnings}/3`);
                            break;
                    }
                    return;
                }
            }
        }

        // Пользовательские триггеры
        const custom = chat.customCommands[lower];
        if (custom) {
            ctx.reply(custom).catch(() => {});
        }

        updateRankScore(user);
        checkAchievements(user, ctx);
        saveDb();
    } catch (e) {
        logger.error('Ошибка в обработчике текста:', e);
    }
});

// ==============================================
// 25. ТАЙМЕРЫ
// ==============================================
setInterval(async () => {
    const now = Date.now();

    let warnsReset = false;
    for (const userId in dbData.users) {
        const user = dbData.users[userId];
        if (checkAndResetWarns(user)) {
            warnsReset = true;
            logger.info(`Варны сброшены для пользователя ${userId} (${user.name})`);
        }
    }

    if (warnsReset) {
        saveDb();
    }

    if (dbData.config && dbData.config.antiRaid && dbData.config.antiRaid.activeUntil > 0) {
        if (now >= dbData.config.antiRaid.activeUntil) {
            dbData.config.antiRaid.activeUntil = 0;
            saveDb();

            for (const chatId of dbData.knownChats || []) {
                try {
                    await bot.telegram.setChatPermissions(chatId, FULL_CHAT_PERMISSIONS);
                    await bot.telegram.sendMessage(chatId, "🟢 <b>Режим Anti-Raid автоматически завершён!</b> Чат снова открыт для сообщений.", { parse_mode: 'HTML' });
                } catch (e) {}
            }
        }
    }

    for (const chatId in dbData.chats) {
        const chat = dbData.chats[chatId];
        if (chat.scheduledPosts) {
            for (const post of chat.scheduledPosts) {
                if (now - post.lastSent >= post.intervalMs) {
                    try {
                        if (post.photo) {
                            await bot.telegram.sendPhoto(chatId, post.photo, { caption: post.text || '' });
                        } else {
                            await bot.telegram.sendMessage(chatId, post.text);
                        }
                        post.lastSent = now;
                        saveDb();
                    } catch (e) {
                        logger.error(`Ошибка отправки запланированного сообщения в ${chatId}:`, e.message);
                    }
                }
            }
        }
    }
}, Config.WARN_CHECK_INTERVAL);

// ==============================================
// 26. ЗАПУСК И БЕЗОПАСНОЕ ЗАВЕРШЕНИЕ
// ==============================================
bot.catch((err, ctx) => {
    logger.error(`Глобальная ошибка при обработке обновления (${ctx.updateType}):`, err);
});

loadDb();

bot.launch()
    .then(() => {
        logger.info("🤖 Бот успешно запущен и готов к работе!");
        logger.info(`🔄 Варны автоматически сбрасываются через ${Config.WARN_RESET_DAYS} дней`);
        logger.info(`🏆 Достижений в системе: ${ACHIEVEMENTS.length} (скрытых: ${ACHIEVEMENTS.filter(a => a.hidden).length})`);
        logger.info(`👨‍💻 Разработчик: ${Config.DEV_USERNAME} (ID: ${Config.DEV_ID})`);
        if (aiClient) {
            logger.info(`🧠 ИИ активен. Модель: ${Config.AI.model}`);
        } else {
            logger.warn('⚠️ ИИ не активен. Добавьте OPENROUTER_API_KEY в .env');
        }
    })
    .catch((err) => {
        logger.error("❌ Ошибка запуска бота:", err);
    });

process.once('SIGINT', () => {
    saveDbSync();
    bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
    saveDbSync();
    bot.stop('SIGTERM');
});
