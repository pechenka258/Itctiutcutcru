const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
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
    ADMIN_IDS: [123456789], // Укажите ваш Telegram ID
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
        message: "👋 Добро пожаловать, {mention} в {chat_title}! Вы {count}-й участник. Прочитай правила командой /rules.",
        goodbye_message: "😢 Пользователь {mention} покинул чат."
    },
    CAPTCHA: {
        enabled: true,
        timeout_ms: 180000
    },
    REPORTS: {
        enabled: true,
        cooldown: 300000,
        types: ["Спам", "Оскорбления", "Неуместный контент", "Мошенничество", "Другое"]
    }
};

const DEFAULT_ACHIEVEMENTS = [
    { name: "Новичок", description: "Отправил первое сообщение", icon: "👶" },
    { name: "Активный", description: "100 сообщений", icon: "💬" },
    { name: "Болтун", description: "500 сообщений", icon: "🗣" },
    { name: "Писатель", description: "1000 сообщений", icon: "✍️" },
    { name: "Медиамагнат", description: "50 медиафайлов", icon: "📷" },
    { name: "Страж", description: "Отправил 10 репортов", icon: "🛡️" }
];

// ==============================================
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
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

function generateMathProblem() {
    const a = Math.floor(Math.random() * 10) + 1;
    const b = Math.floor(Math.random() * 10) + 1;
    const correct = a + b;
    const choices = new Set([correct]);
    while (choices.size < 4) {
        choices.add(Math.floor(Math.random() * 20) + 1);
    }
    const sortedChoices = Array.from(choices).sort(() => Math.random() - 0.5);
    return {
        question: `${a} + ${b} = ?`,
        correct: correct.toString(),
        choices: sortedChoices.map(String)
    };
}

function getProgressBar(xp, reqXp) {
    const total = 10;
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

// ==============================================
// 3. ХРАНИЛИЩЕ ДАННЫХ
// ==============================================
const DB_FILE = path.join(__dirname, 'database.json');
let dbData = {
    users: {},
    chats: {},
    reports: [],
    knownChats: [],
    config: {
        rules: "📜 Правила чата:\n1. Уважайте друг друга\n2. Не спамьте и не используйте мат\n3. Реклама запрещена",
        badWords: ['скам', 'казино', 'крипта'],
        allowedDomains: ['github.com', 'google.com', 'youtube.com'],
        customCommands: {},
        welcomeMessage: Config.GREETINGS.message,
        nightMode: { enabled: false, startHour: 23, endHour: 7 },
        antiRaid: { enabled: true, joinLimit: 5, activeUntil: 0 },
        scheduledPosts: []
    }
};

function loadDb() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            dbData = { ...dbData, ...parsed };
            if (!dbData.reports) dbData.reports = [];
            if (!dbData.knownChats) dbData.knownChats = [];
            if (!dbData.chats) dbData.chats = {};
            if (!dbData.config.badWords) dbData.config.badWords = ['скам', 'казино', 'крипта'];
            if (!dbData.config.customCommands) dbData.config.customCommands = {};
            if (!dbData.config.welcomeMessage) dbData.config.welcomeMessage = Config.GREETINGS.message;
            if (!dbData.config.nightMode) dbData.config.nightMode = { enabled: false, startHour: 23, endHour: 7 };
            if (!dbData.config.antiRaid) dbData.config.antiRaid = { enabled: true, joinLimit: 5, activeUntil: 0 };
            if (!dbData.config.scheduledPosts) dbData.config.scheduledPosts = [];
            logger.info('База данных успешно загружена.');
        } catch (e) {
            logger.error('Ошибка чтения файла БД:', e);
        }
    }
}

function saveDb() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(dbData, null, 2), 'utf8');
    } catch (e) {
        logger.error('Ошибка сохранения БД:', e);
    }
}

function getUser(userId, userName = "Пользователь") {
    if (!dbData.users[userId]) {
        dbData.users[userId] = {
            userId,
            name: userName,
            joinDate: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            totalMessages: 0,
            totalChars: 0,
            warnings: 0,
            warnMuted: false,
            mutes: 0,
            bans: 0,
            rankScore: 0,
            karma: 0,
            xp: 0,
            level: 1,
            karmaGivenToday: 0,
            lastKarmaReset: getTodayKey(),
            lastReportTime: null,
            mediaStats: { PHOTO: 0, VIDEO: 0, VOICE: 0, STICKER: 0, DOCUMENT: 0, ANIMATION: 0 },
            achievements: []
        };
    }
    dbData.users[userId].name = userName;
    if (dbData.users[userId].karma === undefined) dbData.users[userId].karma = 0;
    if (dbData.users[userId].xp === undefined) dbData.users[userId].xp = 0;
    if (dbData.users[userId].level === undefined) dbData.users[userId].level = 1;
    if (dbData.users[userId].karmaGivenToday === undefined) dbData.users[userId].karmaGivenToday = 0;
    if (dbData.users[userId].lastKarmaReset === undefined) dbData.users[userId].lastKarmaReset = getTodayKey();
    return dbData.users[userId];
}

function addXp(user, amount, ctx) {
    user.xp += amount;
    const reqXp = user.level * 50;
    if (user.xp >= reqXp) {
        user.level++;
        user.xp -= reqXp;
        if (ctx && ctx.reply) {
            ctx.reply(`🎉 Поздравляем, ${user.name}! Вы достигли ${user.level} уровня! (${getTitleByLevel(user.level)})`);
        }
    }
}

function getChatData(chatId, chatTitle = "Чат") {
    if (!dbData.chats[chatId]) {
        dbData.chats[chatId] = {
            id: chatId,
            title: chatTitle,
            totalMessages: 0,
            dailyStats: {},
            weeklyStats: {},
            userActivity: {}
        };
    }
    if (chatTitle && chatTitle !== "Чат") {
        dbData.chats[chatId].title = chatTitle;
    }
    return dbData.chats[chatId];
}

function trackMessage(ctx) {
    if (!ctx.chat || ctx.chat.type === 'private') return;

    const userId = ctx.from.id;
    const userName = ctx.from.first_name || "Пользователь";
    const chatId = ctx.chat.id;
    const chatTitle = ctx.chat.title || "Чат";

    getUser(userId, userName);
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
}

function updateRankScore(user) {
    const mediaTotal = Object.values(user.mediaStats).reduce((a, b) => a + b, 0);
    const penalties = (user.warnings + user.bans) * 10;
    user.rankScore = (user.totalMessages * 1) + (mediaTotal * 2) + (user.karma * 5) - penalties;
}

function checkAchievements(user, ctx) {
    const grant = (name) => {
        if (!user.achievements.includes(name)) {
            user.achievements.push(name);
            const ach = DEFAULT_ACHIEVEMENTS.find(a => a.name === name);
            if (ach) ctx.reply(`🏆 Новое достижение: ${ach.icon} ${ach.name} — ${ach.description}`);
        }
    };

    if (user.totalMessages >= 1) grant("Новичок");
    if (user.totalMessages >= 100) grant("Активный");
    if (user.totalMessages >= 500) grant("Болтун");
    if (user.totalMessages >= 1000) grant("Писатель");

    const totalMedia = Object.values(user.mediaStats).reduce((a, b) => a + b, 0);
    if (totalMedia >= 50) grant("Медиамагнат");
}

const reportSessions = new Map();
const pendingCaptchas = new Map();
const activeDuels = new Map();
const joinTimestamps = [];

const bot = new Telegraf(process.env.BOT_TOKEN);

// ==============================================
// 4. ПРОВЕРКИ АДМИНОВ И ВРЕМЕНИ
// ==============================================
async function isAdmin(ctx, userId) {
    if (Config.ADMIN_IDS.includes(userId)) return true;
    if (ctx.chat && ['group', 'supergroup'].includes(ctx.chat.type)) {
        try {
            const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
            return ['administrator', 'creator'].includes(member.status);
        } catch (e) {
            return false;
        }
    }
    return false;
}

async function isAnywhereAdmin(telegram, userId) {
    if (Config.ADMIN_IDS.includes(userId)) return true;
    for (const chatId of dbData.knownChats) {
        try {
            const member = await telegram.getChatMember(chatId, userId);
            if (['administrator', 'creator'].includes(member.status)) return true;
        } catch (e) {}
    }
    return false;
}

async function getChatAdminsList(telegram, chatId) {
    const adminIds = new Set(Config.ADMIN_IDS);
    try {
        const admins = await telegram.getChatAdministrators(chatId);
        admins.forEach(a => adminIds.add(a.user.id));
    } catch (e) {
        logger.warn(`Не удалось получить список админов чата ${chatId}:`, e.message);
    }
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
    if (['мин', 'минута', 'минуты', 'минут', 'м', 'm'].includes(unit)) return { seconds: val * 60, text: `${val} мин.` };
    if (['час', 'часа', 'часов', 'ч', 'h'].includes(unit)) return { seconds: val * 3600, text: `${val} ч.` };
    if (['день', 'дня', 'дней', 'д', 'd'].includes(unit)) return { seconds: val * 86400, text: `${val} дн.` };

    return { seconds: val * 60, text: `${val} мин.` };
}

// ==============================================
// 5. ЕДИНАЯ СИСТЕМА ЭСКАЛАЦИИ 3 НАРУШЕНИЙ / РЕПОРТОВ
// ==============================================
async function handleThreeStrikePunishment(ctx, targetUser, chatId) {
    const target = getUser(targetUser.id, targetUser.first_name);

    if (!target.warnMuted) {
        target.warnMuted = true;
        target.warnings = 0;
        target.mutes++;
        saveDb();

        const oneWeekSeconds = 7 * 24 * 3600;
        try {
            await ctx.telegram.restrictChatMember(chatId, targetUser.id, {
                permissions: { can_send_messages: false },
                until_date: Math.floor(Date.now() / 1000) + oneWeekSeconds
            });
            await ctx.telegram.sendMessage(chatId, `⚠️ Пользователь ${targetUser.first_name} накопил 3 нарушения/репорта и отправлен в МУТ на 1 неделю!\n\n❗️ Внимание: При повторном накоплении 3 нарушений последует БАН.`);
        } catch (e) {
            await ctx.telegram.sendMessage(chatId, `⚠️ Пользователь ${targetUser.first_name} накопил 3 нарушения, но боту не удалось выдать мут.`);
        }
    } else {
        target.warnings = 0;
        target.bans++;
        saveDb();

        try {
            await ctx.telegram.banChatMember(chatId, targetUser.id);
            await ctx.telegram.sendMessage(chatId, `⛔ Пользователь ${targetUser.first_name} повторно накопил 3 нарушения/репорта и был ЗАБАНЕН в чате!`);
        } catch (e) {
            await ctx.telegram.sendMessage(chatId, `⛔ Не удалось забанить пользователя ${targetUser.first_name}.`);
        }
    }
}

async function addWarnAndCheck(ctx, targetUser) {
    const target = getUser(targetUser.id, targetUser.first_name);
    target.warnings++;

    if (target.warnings >= 3) {
        return handleThreeStrikePunishment(ctx, targetUser, ctx.chat.id);
    }

    saveDb();
    const stage = target.warnMuted ? "Второй этап (след. предел — БАН)" : "Первый этап (след. предел — МУТ на 7 дней)";
    return ctx.reply(`⚠️ Выдано предупреждение ${targetUser.first_name}. Всего: ${target.warnings}/3. [${stage}]`);
}

// ==============================================
// 6. ПРОВЕРКИ ТЕКСТА
// ==============================================
function containsBadWords(text) {
    const lower = text.toLowerCase();
    return dbData.config.badWords.some(word => lower.includes(word.toLowerCase()));
}

function containsUnauthorizedLinks(text) {
    if (Config.FILTERS.ALLOW_LINKS) return false;
    const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s]*)/gi;
    const tgInviteRegex = /(t\.me\/[^\s]+)|(telegram\.me\/[^\s]+)|(tg:\/\/join\?invite=[^\s]+)/gi;

    if (Config.FILTERS.BLOCK_TELEGRAM_INVITES && tgInviteRegex.test(text)) return true;

    const matches = text.match(urlRegex);
    if (!matches) return false;

    for (const urlStr of matches) {
        try {
            const formattedUrl = urlStr.startsWith('http') ? urlStr : `http://${urlStr}`;
            const hostname = new URL(formattedUrl).hostname.replace('www.', '');
            const isAllowed = dbData.config.allowedDomains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
            if (!isAllowed) return true;
        } catch (e) {
            return true;
        }
    }
    return false;
}

// ==============================================
// 7. ТЕКСТ СТАТИСТИКИ И ПРОФИЛЯ
// ==============================================
function buildPersonalStatsText(user) {
    const mediaTotal = Object.values(user.mediaStats).reduce((a, b) => a + b, 0);
    const achievementsCount = user.achievements.length;
    const reqXp = user.level * 50;
    const pBar = getProgressBar(user.xp, reqXp);
    const title = getTitleByLevel(user.level);

    return `👤 <b>Профиль пользователя: ${escapeHtml(user.name)}</b>

🎖️ <b>Титул:</b> ${title}
⭐ <b>Уровень:</b> ${user.level}
📊 <b>Опыт:</b> ${user.xp} / ${reqXp} XP
<code>[${pBar}]</code>

❤️ <b>Репутация (Карма):</b> ${user.karma}
💬 Всего сообщений: ${user.totalMessages}
🔤 Всего символов: ${user.totalChars}
📷 Отправлено медиа: ${mediaTotal}
🏆 Очки рейтинга: ${user.rankScore}
🏅 Достижений: ${achievementsCount}/${DEFAULT_ACHIEVEMENTS.length}

⚠️ Предупреждений: ${user.warnings}/3 (${user.warnMuted ? "Этап 2: След. предел — БАН" : "Этап 1: След. предел — МУТ 7 дней"})
🔇 Мутов: ${user.mutes}
⛔ Банов: ${user.bans}`;
}

function buildGroupStatsText(chat) {
    const today = getTodayKey();
    const week = getWeekKey();

    const todayCount = chat.dailyStats[today] || 0;
    const weekCount = chat.weeklyStats[week] || 0;
    const totalCount = chat.totalMessages || 0;

    const topUsers = Object.values(chat.userActivity || {})
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

    let topText = "";
    if (topUsers.length > 0) {
        topText = "\n\n🏆 Топ активных участников:\n";
        topUsers.forEach((u, i) => {
            const percent = totalCount > 0 ? ((u.count / totalCount) * 100).toFixed(1) : 0;
            topText += `${i + 1}. ${u.name} — ${u.count} сообщ. (${percent}%)\n`;
        });
    } else {
        topText = "\n\n🏆 Активных участников пока нет.";
    }

    return `📈 Подробная статистика группы: "${chat.title}"

📅 Сообщений за сегодня: ${todayCount}
📆 Сообщений за эту неделю: ${weekCount}
💬 Всего сообщений за всё время: ${totalCount}${topText}`;
}

// ==============================================
// 8. ИНЛАЙН МЕНЮ И ОБРАБОТЧИКИ КНОПОК
// ==============================================
function getMainMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback("📊 Мой профиль", "menu_my_stats")],
        [Markup.button.callback("📈 Статистика групп", "menu_group_stats")],
        [Markup.button.callback("📋 Активные репорты", "view_reports")]
    ]);
}

bot.start(async (ctx) => {
    try {
        if (ctx.chat.type === 'private') {
            const userId = ctx.from.id;
            const rawName = ctx.from.first_name || "Пользователь";
            const userName = escapeHtml(rawName);
            
            const isNewUser = !dbData.users[userId];
            getUser(userId, rawName);
            saveDb();

            const welcomeText = 
`👋 <b>Привет, ${userName}!</b> ${isNewUser ? 'Рад знакомству!' : 'С возвращением!'}

Я — расширенный <b>бот-модератор</b> и помощник для управления Telegram-группами.

🛡️ <b>Безопасность:</b>
• Математическая капча, Ночной режим (`/nightmode`), Anti-Raid защита от наплыва ботов.

🎮 <b>Геймификация и Сообщество:</b>
• Карма/Репутация за "спасибо" или "+1", профиль с уровнями (`/profile`), дуэли (`/duel`).

⚙️ <b>Автоматизация:</b>
• Кастомные команды (`/addcmd`), настраиваемое приветствие (`/setwelcome`) и запланированные посты (`/addschedule`).

Используйте `/help` для полного списка команд!`;

            return await ctx.replyWithHTML(welcomeText, getMainMenu());
        }
        await ctx.reply("Бот активен в группе! Для вызова справки отправьте /help.");
    } catch (err) {
        logger.error("Ошибка при выполнении команды /start:", err);
    }
});

bot.action('menu_main', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageText(`🤖 Выберите действие из меню:`, getMainMenu()).catch(() => {});
});

bot.action('menu_my_stats', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = getUser(ctx.from.id, ctx.from.first_name);
    await ctx.editMessageText(buildPersonalStatsText(user), {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Назад", "menu_main")]])
    }).catch(() => {});
});

bot.action('menu_group_stats', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const chatIds = Object.keys(dbData.chats);
    if (chatIds.length === 0) {
        return ctx.editMessageText("📊 У бота пока нет сохраненной статистики по группам.", Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Назад", "menu_main")]
        ])).catch(() => {});
    }

    const buttons = chatIds.map(id => [
        Markup.button.callback(`👥 ${dbData.chats[id].title}`, `show_gstat_${id}`)
    ]);
    buttons.push([Markup.button.callback("⬅️ Назад", "menu_main")]);

    await ctx.editMessageText("Выберите группу для просмотра статистики:", Markup.inlineKeyboard(buttons)).catch(() => {});
});

bot.action(/^show_gstat_(-?\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.match[1];
    const chat = dbData.chats[chatId];

    if (!chat) return ctx.answerCbQuery("Данные группы не найдены.", { show_alert: true });

    await ctx.editMessageText(buildGroupStatsText(chat), Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ К списку групп", "menu_group_stats")]
    ])).catch(() => {});
});

bot.action('view_reports', async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const userIsAdmin = await isAnywhereAdmin(ctx.telegram, ctx.from.id);
    
    if (!userIsAdmin) {
        return ctx.editMessageText("⛔ Просмотр активных репортов доступен только администраторам.", Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Назад", "menu_main")]
        ])).catch(() => {});
    }

    if (!dbData.reports || dbData.reports.length === 0) {
        return ctx.editMessageText("📋 Активных репортов нет!", Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Назад", "menu_main")]
        ])).catch(() => {});
    }

    let text = "📋 Список активных репортов:\n\n";
    dbData.reports.slice(0, 10).forEach((r, idx) => {
        text += `${idx + 1}. Чат: ${r.chatTitle}\n   На: ${r.reportedName} (ID: ${r.reportedId})\n   Причина: ${r.reason}\n\n`;
    });

    await ctx.editMessageText(text, Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад", "menu_main")]
    ])).catch(() => {});
});

// ==============================================
// 9. КОМАНДЫ МОДЕРАЦИИ, КАСТОМИЗАЦИИ И ГЕЙМИФИКАЦИИ
// ==============================================
async function handleCallEveryone(ctx) {
    if (ctx.chat.type === 'private') return ctx.reply("⚠️ Эта команда работает только в группах!");
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ Ошибка: Вызывать всех могут только админы!");

    const chat = getChatData(ctx.chat.id, ctx.chat.title);
    const userIds = Object.keys(chat.userActivity || {}).filter(id => parseInt(id, 10) !== ctx.from.id);

    if (userIds.length === 0) return ctx.reply("📢 В базе нет участников для созыва.");

    let reasonText = ctx.message.text.replace(/^\/(all|everyone)|^@(all|everyone)/i, '').trim();
    let header = `📣 <b>СОЗЫВ ВСЕХ УЧАСТНИКОВ!</b>\nОт: ${escapeHtml(ctx.from.first_name)}\n`;
    if (reasonText) header += `💬 Сообщение: ${escapeHtml(reasonText)}\n`;
    header += `\n`;

    let mentions = userIds.map(id => `<a href="tg://user?id=${id}">${escapeHtml(chat.userActivity[id].name)}</a>`);

    const chunkSize = 30;
    for (let i = 0; i < mentions.length; i += chunkSize) {
        const chunk = mentions.slice(i, i + chunkSize);
        await ctx.replyWithHTML((i === 0 ? header : "") + chunk.join(', ')).catch(err => logger.error("Ошибка упоминания:", err));
    }
}

bot.command(['all', 'everyone'], handleCallEveryone);

// --- Геймификация: Профиль и Дуэли ---
bot.command(['profile', 'me'], (ctx) => {
    const user = getUser(ctx.from.id, ctx.from.first_name);
    ctx.replyWithHTML(buildPersonalStatsText(user));
});

bot.command('duel', async (ctx) => {
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
        `⚔️ <b>${escapeHtml(challenger.first_name)}</b> вызывает на дуэль <b>${escapeHtml(opponent.first_name)}</b>!\nПобедитель получит +25 XP!`,
        Markup.inlineKeyboard([
            [Markup.button.callback("⚔️ Принять вызов", `duel_accept_${duelId}`)],
            [Markup.button.callback("🏳️ Отклонить", `duel_decline_${duelId}`)]
        ])
    );
});

bot.action(/^duel_accept_(.+)$/, async (ctx) => {
    const duelId = ctx.match[1];
    const duel = activeDuels.get(duelId);
    if (!duel) return ctx.answerCbQuery("Дуэль устарела.");

    if (ctx.from.id !== duel.opponent.id) {
        return ctx.answerCbQuery("⛔ Вызов брошен не вам!", { show_alert: true });
    }

    await ctx.answerCbQuery("Вызов принят!");
    await ctx.editMessageText(`🎲 Дуэль начинается между <b>${escapeHtml(duel.challenger.first_name)}</b> и <b>${escapeHtml(duel.opponent.first_name)}</b>! Бросаем кубики...`, { parse_mode: 'HTML' });

    const msg1 = await ctx.replyWithDice();
    const msg2 = await ctx.replyWithDice();

    setTimeout(() => {
        const val1 = msg1.dice.value;
        const val2 = msg2.dice.value;

        let resultText = `🎲 Результат броска:\n• ${escapeHtml(duel.challenger.first_name)}: <b>${val1}</b>\n• ${escapeHtml(duel.opponent.first_name)}: <b>${val2}</b>\n\n`;

        if (val1 > val2) {
            const winner = getUser(duel.challenger.id, duel.challenger.first_name);
            addXp(winner, 25, ctx);
            resultText += `🏆 Победитель: <b>${escapeHtml(duel.challenger.first_name)}</b> (+25 XP)!`;
        } else if (val2 > val1) {
            const winner = getUser(duel.opponent.id, duel.opponent.first_name);
            addXp(winner, 25, ctx);
            resultText += `🏆 Победитель: <b>${escapeHtml(duel.opponent.first_name)}</b> (+25 XP)!`;
        } else {
            resultText += `🤝 Ничья! Победила дружба!`;
        }

        saveDb();
        ctx.replyWithHTML(resultText);
        activeDuels.delete(duelId);
    }, 3500);
});

bot.action(/^duel_decline_(.+)$/, async (ctx) => {
    const duelId = ctx.match[1];
    const duel = activeDuels.get(duelId);
    if (!duel) return ctx.answerCbQuery("Дуэль устарела.");

    if (ctx.from.id !== duel.opponent.id && ctx.from.id !== duel.challenger.id) {
        return ctx.answerCbQuery("⛔ Вы не участник дуэли!", { show_alert: true });
    }

    activeDuels.delete(duelId);
    ctx.editMessageText(`🏳️ Дуэль отклонена.`);
});

// --- Автоматизация: Триггеры, Приветствия, Объявления, Ночной режим ---
bot.command('addcmd', async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ У вас нет прав!");
    const parts = ctx.message.text.split(' ').slice(1);
    const trigger = parts[0];
    const response = parts.slice(1).join(' ').trim();

    if (!trigger || !response) {
        return ctx.replyWithHTML("⚠️ Формат: <code>/addcmd !триггер Ответный текст или ссылка</code>");
    }

    const key = (trigger.startsWith('!') || trigger.startsWith('/') ? trigger : `!${trigger}`).toLowerCase();
    dbData.config.customCommands[key] = response;
    saveDb();
    ctx.replyWithHTML(`✅ Кастомная команда <code>${escapeHtml(key)}</code> успешно добавлена!`);
});

bot.command('delcmd', async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ У вас нет прав!");
    const trigger = ctx.message.text.split(' ').slice(1)[0];
    if (!trigger) return ctx.replyWithHTML("⚠️ Укажите команду: <code>/delcmd !триггер</code>");

    const key = (trigger.startsWith('!') || trigger.startsWith('/') ? trigger : `!${trigger}`).toLowerCase();
    if (!dbData.config.customCommands[key]) return ctx.reply("⚠️ Команда не найдена.");

    delete dbData.config.customCommands[key];
    saveDb();
    ctx.replyWithHTML(`🗑️ Кастомная команда <code>${escapeHtml(key)}</code> удалена!`);
});

bot.command('customcmds', (ctx) => {
    const cmds = Object.keys(dbData.config.customCommands || {});
    if (cmds.length === 0) return ctx.reply("📜 Список кастомных команд пуст.");
    ctx.replyWithHTML(`⚙️ <b>Кастомные команды (${cmds.length}):</b>\n\n` + cmds.map(c => `• <code>${escapeHtml(c)}</code>`).join('\n'));
});

bot.command('setwelcome', async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ У вас нет прав!");
    const text = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!text) return ctx.replyWithHTML("⚠️ Укажите текст приветствия. Тэги: <code>{mention}</code>, <code>{chat_title}</code>, <code>{count}</code>");

    dbData.config.welcomeMessage = text;
    saveDb();
    ctx.reply("✅ Приветственное сообщение обновлено!");
});

bot.command('nightmode', async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ У вас нет прав!");
    const arg = ctx.message.text.split(' ').slice(1)[0];
    if (arg === 'on') {
        dbData.config.nightMode.enabled = true;
        saveDb();
        return ctx.reply("🌙 Ночной режим ВКЛЮЧЁН (с 23:00 до 07:00 запрет ссылок и медиа).");
    } else if (arg === 'off') {
        dbData.config.nightMode.enabled = false;
        saveDb();
        return ctx.reply("☀️ Ночной режим ВЫКЛЮЧЁН.");
    }
    ctx.reply(`ℹ️ Статус ночного режима: ${dbData.config.nightMode.enabled ? "ВКЛ" : "ВЫКЛ"}\nИспользование: /nightmode on | /nightmode off`);
});

bot.command('addschedule', async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ У вас нет прав!");
    const parts = ctx.message.text.split(' ').slice(1);
    const minutes = parseInt(parts[0], 10);
    const text = parts.slice(1).join(' ').trim();

    if (isNaN(minutes) || minutes < 1 || !text) {
        return ctx.replyWithHTML("⚠️ Формат: <code>/addschedule [минуты] [текст объявления]</code>");
    }

    const newPost = { id: Date.now().toString(), chatId: ctx.chat.id, intervalMs: minutes * 60 * 1000, lastSent: Date.now(), text };
    dbData.config.scheduledPosts.push(newPost);
    saveDb();
    ctx.replyWithHTML(`⏰ Объявление добавлено! Публикация каждые ${minutes} мин.`);
});

bot.command('schedules', async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ У вас нет прав!");
    const posts = (dbData.config.scheduledPosts || []).filter(p => p.chatId === ctx.chat.id);
    if (posts.length === 0) return ctx.reply("📋 Запланированных объявлений нет.");

    let text = "📋 <b>Список запланированных объявлений:</b>\n\n";
    posts.forEach((p, i) => {
        text += `${i + 1}. ID: <code>${p.id}</code> | Каждые ${Math.round(p.intervalMs / 60000)} мин.\nТекст: ${escapeHtml(p.text.slice(0, 50))}...\n\n`;
    });
    ctx.replyWithHTML(text);
});

bot.command('delschedule', async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ У вас нет прав!");
    const id = ctx.message.text.split(' ').slice(1)[0];
    if (!id) return ctx.replyWithHTML("⚠️ Укажите ID: <code>/delschedule ID</code>");

    dbData.config.scheduledPosts = dbData.config.scheduledPosts.filter(p => p.id !== id);
    saveDb();
    ctx.reply("🗑️ Объявление удалено.");
});

// --- Управление фильтром слов ---
bot.command('addword', async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ Ошибка: У вас нет прав!");
    const word = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();
    if (!word) return ctx.replyWithHTML("⚠️ Укажите слово: <code>/addword слово</code>");

    if (dbData.config.badWords.includes(word)) {
        return ctx.replyWithHTML(`⚠️ Слово <code>${escapeHtml(word)}</code> уже есть в фильтре!`);
    }

    dbData.config.badWords.push(word);
    saveDb();
    ctx.replyWithHTML(`✅ Слово <code>${escapeHtml(word)}</code> добавлено в фильтр!`);
});

bot.command(['delword', 'removeword'], async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ Ошибка: У вас нет прав!");
    const word = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();
    if (!word) return ctx.replyWithHTML("⚠️ Укажите слово: <code>/delword слово</code>");

    const index = dbData.config.badWords.indexOf(word);
    if (index === -1) return ctx.replyWithHTML(`⚠️ Слова <code>${escapeHtml(word)}</code> нет в фильтре!`);

    dbData.config.badWords.splice(index, 1);
    saveDb();
    ctx.replyWithHTML(`🗑️ Слово <code>${escapeHtml(word)}</code> удалено из фильтра!`);
});

bot.command(['badwords', 'words'], async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ Только админы могут смотреть список слов.");
    if (dbData.config.badWords.length === 0) return ctx.reply("📜 Список запрещённых слов пуст.");

    const wordsList = dbData.config.badWords.map(w => `• <code>${escapeHtml(w)}</code>`).join('\n');
    ctx.replyWithHTML(`🚫 <b>Запрещённые слова (${dbData.config.badWords.length}):</b>\n\n${wordsList}`);
});

bot.help((ctx) => {
    ctx.reply(
`📚 Справка по командам бота:

👤 Для всех участников:
• /start — Главное меню в ЛС
• /help — Показать эту справку
• /rules — Просмотреть правила чата
• /profile | /me — Карточка профиля, опыт и карма
• /duel — Вызов на дуэль (ответом на сообщение)
• /chatstats | /gstats — Статистика группы
• /report — Пожаловаться (ответом на сообщение)

⚙️ Управление чатом (Админы):
• /all <текст> — Позвать всех участник
• /setwelcome <текст> — Настроить приветствие ({mention}, {chat_title}, {count})
• /addcmd !cmd <текст> — Добавить триггер-команду
• /delcmd !cmd | /customcmds — Удалить / список триггеров
• /nightmode on|off — Управление ночным режимом
• /addschedule <мин> <текст> — Добавить авто-объявление
• /schedules | /delschedule <id> — Управление объявлениями
• /addword <слово> | /delword <слово> | /words — Фильтр слов

🛡️ Модерация (ответом на сообщение):
• /warn | /unwarn — Предупреждение (3 варна = МУТ 7 дней, повторные 3 = БАН)
• /mute <время> | /unmute — Выдать/снять мут (10м, 2ч, 1д)
• /ban | /kick — Забанить или кикнуть`
    );
});

bot.command('rules', (ctx) => ctx.reply(dbData.config.rules));

bot.command('setrules', async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ У вас нет прав!");
    const newRules = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!newRules) return ctx.reply("⚠️ Укажите текст правил.");

    dbData.config.rules = `📜 Правила чата:\n${newRules}`;
    saveDb();
    ctx.reply("✅ Правила успешно обновлены!");
});

bot.command(['chatstats', 'gstats'], (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply("Статистика доступна в меню /start");
    ctx.reply(buildGroupStatsText(getChatData(ctx.chat.id, ctx.chat.title)));
});

// ==============================================
// 10. РЕПОРТЫ
// ==============================================
function startReportSequence(ctx) {
    if (!Config.REPORTS.enabled) return ctx.reply("Репорты отключены.");
    if (!ctx.message.reply_to_message) return ctx.reply("Ответьте на сообщение нарушителя.");

    const reporterId = ctx.from.id;
    const reportedUser = ctx.message.reply_to_message.from;
    if (reportedUser.id === reporterId) return ctx.reply("Нельзя пожаловаться на себя!");

    const user = getUser(reporterId);
    if (user.lastReportTime && (Date.now() - new Date(user.lastReportTime).getTime()) < Config.REPORTS.cooldown) {
        return ctx.reply("Вы можете отправлять репорты не чаще раза в 5 минут.");
    }

    reportSessions.set(reporterId, {
        reportedId: reportedUser.id,
        reportedName: reportedUser.first_name,
        chatId: ctx.chat.id,
        chatTitle: ctx.chat.title || "Чат",
        messageId: ctx.message.reply_to_message.message_id
    });

    const buttons = Config.REPORTS.types.map((type, i) => [
        Markup.button.callback(type, `rep_reason_${reporterId}__${i}`)
    ]);
    buttons.push([Markup.button.callback("Отмена", `rep_cancel_${reporterId}`)]);
    ctx.reply("Выберите причину жалобы:", Markup.inlineKeyboard(buttons));
}

bot.command('report', startReportSequence);

bot.action(/^rep_reason_(\d+)_(\d+)$/, async (ctx) => {
    const reporterId = parseInt(ctx.match[1], 10);
    const reasonIndex = parseInt(ctx.match[2], 10);

    if (ctx.from.id !== reporterId) return ctx.answerCbQuery("⛔ Это не ваш репорт!", { show_alert: true });

    const session = reportSessions.get(reporterId);
    if (!session) return ctx.answerCbQuery("Сессия устарела.");

    session.reason = Config.REPORTS.types[reasonIndex];
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `Пожаловаться на ${session.reportedName}?\nПричина: ${session.reason}`,
        Markup.inlineKeyboard([
            [Markup.button.callback("✅ Подтвердить", `rep_confirm_${reporterId}`)],
            [Markup.button.callback("❌ Отмена", `rep_cancel_${reporterId}`)]
        ])
    );
});

bot.action(/^rep_confirm_(\d+)$/, async (ctx) => {
    const reporterId = parseInt(ctx.match[1], 10);
    if (ctx.from.id !== reporterId) return ctx.answerCbQuery("⛔ Это не ваш репорт!", { show_alert: true });

    const session = reportSessions.get(reporterId);
    if (!session) return ctx.answerCbQuery("Ошибка сессии.");

    const user = getUser(reporterId);
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
    saveDb();

    const activeReportsForUser = dbData.reports.filter(r => r.reportedId === session.reportedId && r.chatId === session.chatId);

    if (activeReportsForUser.length >= 3) {
        dbData.reports = dbData.reports.filter(r => !(r.reportedId === session.reportedId && r.chatId === session.chatId));
        saveDb();

        await ctx.editMessageText("✅ Жалоба принята. Пользователь накопил 3/3 репортов!");
        reportSessions.delete(reporterId);

        return handleThreeStrikePunishment(ctx, { id: session.reportedId, first_name: session.reportedName }, session.chatId);
    }

    const adminIds = await getChatAdminsList(ctx.telegram, session.chatId);
    const reportText = `⚠️ Новая жалоба! (${activeReportsForUser.length}/3)\n💬 Чат: ${session.chatTitle}\n👤 От: ${ctx.from.first_name}\n👥 На: ${session.reportedName}\n📌 Причина: ${session.reason}`;

    for (const adminId of adminIds) {
        try {
            await ctx.telegram.sendMessage(adminId, reportText, Markup.inlineKeyboard([
                [
                    Markup.button.callback("⚠️ Варн", `adm_warn_${session.reportedId}_${session.chatId}_${reportObj.id}`),
                    Markup.button.callback("🔇 Мут 30м", `adm_mute_${session.reportedId}_${session.chatId}_${reportObj.id}`)
                ],
                [
                    Markup.button.callback("⛔ Бан", `adm_ban_${session.reportedId}_${session.chatId}_${reportObj.id}`),
                    Markup.button.callback("❌ Закрыть", `adm_dismiss_${reportObj.id}`)
                ]
            ]));
        } catch (e) {}
    }

    await ctx.editMessageText(`✅ Жалоба отправлена! На пользователя получено ${activeReportsForUser.length}/3 репортов.`);
    reportSessions.delete(reporterId);
});

bot.action(/^rep_cancel_(\d+)$/, async (ctx) => {
    const reporterId = parseInt(ctx.match[1], 10);
    if (ctx.from.id !== reporterId) return ctx.answerCbQuery("⛔ Это не ваш репорт!", { show_alert: true });
    reportSessions.delete(reporterId);
    ctx.editMessageText("Отправка репорта отменена.").catch(() => {});
});

bot.action(/adm_dismiss_(.+)/, async (ctx) => {
    dbData.reports = dbData.reports.filter(r => r.id !== ctx.match[1]);
    saveDb();
    ctx.answerCbQuery("Репорт закрыт.");
});

bot.action(/adm_(warn|mute|ban)_(\d+)_(-?\d+)_(.+)/, async (ctx) => {
    const action = ctx.match[1];
    const targetId = parseInt(ctx.match[2]);
    const targetChatId = parseInt(ctx.match[3]);
    const repId = ctx.match[4];

    if (!await isAnywhereAdmin(ctx.telegram, ctx.from.id)) return ctx.answerCbQuery("⛔ Отказано в доступе!", { show_alert: true });

    const target = getUser(targetId);

    try {
        if (action === 'warn') {
            await addWarnAndCheck(ctx, { id: targetId, first_name: target.name });
        } else if (action === 'mute') {
            target.mutes++;
            await ctx.telegram.restrictChatMember(targetChatId, targetId, {
                permissions: { can_send_messages: false },
                until_date: Math.floor(Date.now() / 1000) + 1800
            });
            await ctx.telegram.sendMessage(targetChatId, `🔇 Пользователь (ID: ${targetId}) замучен на 30 минут.`);
        } else if (action === 'ban') {
            target.bans++;
            await ctx.telegram.banChatMember(targetChatId, targetId);
            await ctx.telegram.sendMessage(targetChatId, `⛔ Пользователь (ID: ${targetId}) забанен.`);
        }

        dbData.reports = dbData.reports.filter(r => r.id !== repId);
        saveDb();
        ctx.answerCbQuery("Действие выполнено!");
    } catch (e) {
        ctx.answerCbQuery("Ошибка выполнения.");
    }
});

// ==============================================
// 11. КОМАНДЫ МОДЕРАЦИИ
// ==============================================
bot.command('warn', async (ctx) => {
    if (await isAdmin(ctx, ctx.from.id) && ctx.message.reply_to_message) {
        await addWarnAndCheck(ctx, ctx.message.reply_to_message.from);
    }
});

bot.command('unwarn', async (ctx) => {
    if (await isAdmin(ctx, ctx.from.id) && ctx.message.reply_to_message) {
        const targetUser = ctx.message.reply_to_message.from;
        const target = getUser(targetUser.id, targetUser.first_name);
        if (target.warnings > 0) target.warnings--;
        saveDb();
        ctx.reply(`✅ Предупреждение снято с ${targetUser.first_name}. Осталось: ${target.warnings}/3`);
    }
});

bot.command('mute', async (ctx) => {
    if (await isAdmin(ctx, ctx.from.id) && ctx.message.reply_to_message) {
        const timeArg = ctx.message.text.split(' ').slice(1).join(' ');
        const { seconds, text } = parseDuration(timeArg);
        const targetUser = ctx.message.reply_to_message.from;
        await ctx.telegram.restrictChatMember(ctx.chat.id, targetUser.id, {
            permissions: { can_send_messages: false },
            until_date: Math.floor(Date.now() / 1000) + seconds
        });
        ctx.reply(`🔇 Пользователь ${targetUser.first_name} замучен на ${text}`);
    }
});

bot.command('unmute', async (ctx) => {
    if (await isAdmin(ctx, ctx.from.id) && ctx.message.reply_to_message) {
        const targetUser = ctx.message.reply_to_message.from;
        await ctx.telegram.restrictChatMember(ctx.chat.id, targetUser.id, {
            permissions: { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true }
        });
        ctx.reply(`🔊 Мут снят с ${targetUser.first_name}.`);
    }
});

bot.command('ban', async (ctx) => {
    if (await isAdmin(ctx, ctx.from.id) && ctx.message.reply_to_message) {
        const targetUser = ctx.message.reply_to_message.from;
        await ctx.telegram.banChatMember(ctx.chat.id, targetUser.id);
        ctx.reply(`⛔ Пользователь ${targetUser.first_name} забанен.`);
    }
});

bot.command('kick', async (ctx) => {
    if (await isAdmin(ctx, ctx.from.id) && ctx.message.reply_to_message) {
        const targetUser = ctx.message.reply_to_message.from;
        await ctx.telegram.banChatMember(ctx.chat.id, targetUser.id);
        await ctx.telegram.unbanChatMember(ctx.chat.id, targetUser.id);
        ctx.reply(`🥾 Пользователь ${targetUser.first_name} кикнут.`);
    }
});

// ==============================================
// 12. ВХОД УЧАСТНИКОВ, КАПЧА И ANTI-RAID
// ==============================================
bot.on('new_chat_members', async (ctx) => {
    if (!Config.GREETINGS.enabled) return;

    // --- Anti-Raid Проверка ---
    const now = Date.now();
    joinTimestamps.push(now);
    while (joinTimestamps.length > 0 && joinTimestamps[0] < now - 10000) {
        joinTimestamps.shift();
    }

    if (joinTimestamps.length >= (dbData.config.antiRaid.joinLimit || 5)) {
        dbData.config.antiRaid.activeUntil = now + (15 * 60 * 1000);
        saveDb();
        try {
            await ctx.setChatPermissions({ can_send_messages: false });
            await ctx.reply("🚨 <b>ОБНАРУЖЕН РЕЙД!</b> Чат переведён в режим «Только чтение» на 15 минут.", { parse_mode: 'HTML' });
        } catch (e) {}
    }

    for (const member of ctx.message.new_chat_members) {
        if (member.is_bot && member.id === ctx.botInfo.id) continue;

        getUser(member.id, member.first_name);
        saveDb();

        const count = await ctx.getChatMembersCount().catch(() => 0);
        const mention = `<a href="tg://user?id=${member.id}">${escapeHtml(member.first_name)}</a>`;
        
        let welcomeMsg = (dbData.config.welcomeMessage || Config.GREETINGS.message)
            .replace(/{mention}/g, mention)
            .replace(/{chat_title}/g, escapeHtml(ctx.chat.title || "Чат"))
            .replace(/{count}/g, count);

        if (Config.CAPTCHA.enabled) {
            try {
                await ctx.restrictChatMember(member.id, { permissions: { can_send_messages: false } });
            } catch (err) {}

            const math = generateMathProblem();
            const sessionKey = `${ctx.chat.id}_${member.id}`;

            const buttons = math.choices.map(choice => 
                Markup.button.callback(choice, `captcha_ans_${member.id}_${choice}`)
            );

            const captchaMessage = await ctx.replyWithHTML(
                `👋 Welcome, ${mention}!\n\n🧩 <b>Капча:</b> Сколько будет <b>${math.question}</b>?\nВыберите правильный ответ в течение 3 минут:`,
                Markup.inlineKeyboard([buttons])
            ).catch(() => null);

            if (captchaMessage) {
                const timer = setTimeout(async () => {
                    if (pendingCaptchas.has(sessionKey)) {
                        try {
                            await ctx.telegram.banChatMember(ctx.chat.id, member.id);
                            await ctx.telegram.unbanChatMember(ctx.chat.id, member.id);
                            await ctx.telegram.deleteMessage(ctx.chat.id, captchaMessage.message_id).catch(() => {});
                        } catch (e) {}
                        pendingCaptchas.delete(sessionKey);
                    }
                }, Config.CAPTCHA.timeout_ms);

                pendingCaptchas.set(sessionKey, { timer, correct: math.correct });
            }
        } else {
            ctx.replyWithHTML(welcomeMsg).catch(() => {});
        }
    }
});

bot.action(/^captcha_ans_(\d+)_(.+)$/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1], 10);
    const selectedAnswer = ctx.match[2];

    if (ctx.from.id !== targetUserId) {
        return ctx.answerCbQuery("⛔ Эта капча не для вас!", { show_alert: true });
    }

    const sessionKey = `${ctx.chat.id}_${targetUserId}`;
    const session = pendingCaptchas.get(sessionKey);

    if (!session) return ctx.answerCbQuery("Время капчи истекло.");

    if (selectedAnswer === session.correct) {
        clearTimeout(session.timer);
        pendingCaptchas.delete(sessionKey);

        try {
            await ctx.restrictChatMember(targetUserId, {
                permissions: { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true }
            });
            await ctx.answerCbQuery("✅ Проверка пройдена!");
            await ctx.editMessageText(`✅ Капча пройдена! Добро пожаловать, ${escapeHtml(ctx.from.first_name)}!`);
        } catch (e) {}
    } else {
        await ctx.answerCbQuery("❌ Неверно! Попробуйте еще раз.", { show_alert: true });
    }
});

// ==============================================
// 13. ОСНОВНОЙ ФИЛЬТР, РЕПУТАЦИЯ И УЧЕТ СООБЩЕНИЙ
// ==============================================
bot.on('text', async (ctx, next) => {
    if (ctx.chat.type === 'private') return next();

    if (!dbData.knownChats.includes(ctx.chat.id)) {
        dbData.knownChats.push(ctx.chat.id);
    }

    trackMessage(ctx);

    const userId = ctx.from.id;
    const text = ctx.message.text.trim();
    const lowerText = text.toLowerCase();
    const user = getUser(userId, ctx.from.first_name);
    const userIsAdmin = await isAdmin(ctx, userId);

    user.totalMessages++;
    user.totalChars += text.length;
    user.lastSeen = new Date().toISOString();
    addXp(user, 2, ctx);
    updateRankScore(user);
    checkAchievements(user, ctx);

    // --- Проверка кастомных команд (триггеров) ---
    if (dbData.config.customCommands && dbData.config.customCommands[lowerText]) {
        return ctx.replyWithHTML(dbData.config.customCommands[lowerText]);
    }

    // --- Проверка Ночного режима ---
    if (dbData.config.nightMode.enabled && isNightTime(dbData.config.nightMode.startHour, dbData.config.nightMode.endHour)) {
        if (!userIsAdmin && containsUnauthorizedLinks(text)) {
            await ctx.deleteMessage().catch(() => {});
            return ctx.reply(`🌙 Включён ночной режим! Отправка ссылок запрещена до ${dbData.config.nightMode.endHour}:00.`);
        }
    }

    // --- Система Кармы (Репутации) ---
    const karmaTriggers = ['+', '+1', 'спасибо', 'thanks', 'реп', '+rep', 'thx', 'благодарю'];
    if (ctx.message.reply_to_message && karmaTriggers.includes(lowerText)) {
        const targetUser = ctx.message.reply_to_message.from;

        if (targetUser.id === userId) {
            return ctx.reply("❌ Нельзя ставить репутацию самому себе!");
        }
        if (targetUser.is_bot) {
            return ctx.reply("🤖 Ботам репутация не нужна!");
        }

        const today = getTodayKey();
        if (user.lastKarmaReset !== today) {
            user.karmaGivenToday = 0;
            user.lastKarmaReset = today;
        }

        if (user.karmaGivenToday >= 5) {
            return ctx.reply("⚠️ Вы исчерпали лимит оценок репутации на сегодня (максимум 5 в день).");
        }

        user.karmaGivenToday++;
        const target = getUser(targetUser.id, targetUser.first_name);
        target.karma++;
        addXp(target, 15, ctx);
        saveDb();

        return ctx.reply(`❤️ ${user.name} повысил(а) репутацию ${target.name}! (Репутация: ${target.karma})`);
    }

    if (lowerText.startsWith('@all') || lowerText.startsWith('@everyone')) {
        await handleCallEveryone(ctx);
        return;
    }

    if (ctx.message.reply_to_message) {
        const targetUser = ctx.message.reply_to_message.from;

        if (lowerText === 'репорт' || lowerText === 'жалоба') {
            startReportSequence(ctx);
            return;
        }

        if (userIsAdmin) {
            if (lowerText === 'варн' || lowerText === 'warn') {
                await addWarnAndCheck(ctx, targetUser);
                return;
            }

            const muteMatch = lowerText.match(/^мут(?:\s+(.+))?$/i);
            if (muteMatch) {
                const timeArg = muteMatch[1] || '';
                const { seconds, text: timeText } = parseDuration(timeArg);
                try {
                    await ctx.telegram.restrictChatMember(ctx.chat.id, targetUser.id, {
                        permissions: { can_send_messages: false },
                        until_date: Math.floor(Date.now() / 1000) + seconds
                    });
                    await ctx.reply(`🔇 Пользователь ${targetUser.first_name} замучен на ${timeText}`);
                } catch (e) {
                    await ctx.reply(`⚠️ Не удалось замутить пользователя ${targetUser.first_name}.`);
                }
                return;
            }
        }
    }

    if (!userIsAdmin) {
        if (containsBadWords(text) || containsUnauthorizedLinks(text)) {
            await ctx.deleteMessage().catch(() => {});
            await addWarnAndCheck(ctx, ctx.from);
            return;
        }
    }

    saveDb();
    return next();
});

// Обработка медиафайлов в ночном режиме
bot.on(['photo', 'video', 'document', 'voice', 'sticker', 'animation'], async (ctx, next) => {
    if (ctx.chat.type === 'private') return next();

    const userId = ctx.from.id;
    const userIsAdmin = await isAdmin(ctx, userId);

    if (dbData.config.nightMode.enabled && isNightTime(dbData.config.nightMode.startHour, dbData.config.nightMode.endHour)) {
        if (!userIsAdmin) {
            await ctx.deleteMessage().catch(() => {});
            return;
        }
    }
    return next();
});

// ==============================================
// 14. ЗАПЛАНИРОВАННЫЕ ПУБЛИКАЦИИ И ЗАПУСК
// ==============================================
setInterval(async () => {
    const now = Date.now();
    if (!dbData.config.scheduledPosts) return;

    for (const post of dbData.config.scheduledPosts) {
        if (now - post.lastSent >= post.intervalMs) {
            post.lastSent = now;
            saveDb();
            try {
                await bot.telegram.sendMessage(post.chatId, `📢 <b>Объявление:</b>\n\n${escapeHtml(post.text)}`, { parse_mode: 'HTML' });
            } catch (e) {
                logger.error(`Ошибка отправки запланированного поста в ${post.chatId}:`, e.message);
            }
        }
    }
}, 30000);

loadDb();

bot.catch((err, ctx) => {
    logger.error(`Ошибка при обработке события ${ctx.updateType}:`, err);
});

bot.launch().then(() => logger.info('Бот запущен и готов к работе!'));

process.once('SIGINT', () => { saveDb(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { saveDb(); bot.stop('SIGTERM'); });
