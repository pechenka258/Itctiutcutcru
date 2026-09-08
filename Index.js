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
        message: "👋 Добро пожаловать, {mention}! Прочитай правила командой /rules.",
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
        allowedDomains: ['github.com', 'google.com', 'youtube.com']
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
            lastReportTime: null,
            mediaStats: { PHOTO: 0, VIDEO: 0, VOICE: 0, STICKER: 0, DOCUMENT: 0, ANIMATION: 0 },
            achievements: []
        };
    }
    dbData.users[userId].name = userName;
    return dbData.users[userId];
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
    user.rankScore = (user.totalMessages * 1) + (mediaTotal * 2) - penalties;
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
// 7. ТЕКСТ СТАТИСТИКИ
// ==============================================
function buildPersonalStatsText(user) {
    const mediaTotal = Object.values(user.mediaStats).reduce((a, b) => a + b, 0);
    const achievementsCount = user.achievements.length;

    return `📊 Личная статистика пользователя ${user.name}:

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
        [Markup.button.callback("📊 Моя статистика", "menu_my_stats")],
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

Я — умный <b>бот-модератор</b> и помощник для управления Telegram-группами.

🛡️ <b>Основные возможности:</b>
• <b>Авто-модерация:</b> Удаление спама, мата и посторонних ссылок.
• <b>Система варнов:</b> 3 предупреждения ➔ мут на 7 дней, повторные 3 варна ➔ бан.
• <b>Капча:</b> Проверка новых участников группы при входе.
• <b>Статистика и Ачивки:</b> Учет сообщений, рейтинг и система достижений.
• <b>Жалобы (Репорты):</b> Возможность участников репортить нарушения администраторам.
• <b>Созыв всех (/all):</b> Массовое уведомление участников группы.

⚙️ <b>Как начать пользоваться:</b>
1. Добавьте меня в вашу группу.
2. Выдайте мне <b>права администратора</b> (удаление сообщений, блокировка участников).
3. Введите в группе команду <code>/help</code>, чтобы посмотреть весь список доступных команд!

Используйте кнопки меню ниже для работы с ботом:`;

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
    await ctx.editMessageText(buildPersonalStatsText(user), Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад", "menu_main")]
    ])).catch(() => {});
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
// 9. КОМАНДЫ МОДЕРАЦИИ, ПРАВИЛ, СОЗЫВА И ФИЛЬТРА СЛОВ
// ==============================================
async function handleCallEveryone(ctx) {
    if (ctx.chat.type === 'private') {
        return ctx.reply("⚠️ Эта команда работает только в группах!");
    }

    const userIsAdmin = await isAdmin(ctx, ctx.from.id);
    if (!userIsAdmin) {
        return ctx.reply("⛔ Ошибка: Вызывать всех участников могут только администраторы!");
    }

    const chat = getChatData(ctx.chat.id, ctx.chat.title);
    const userIds = Object.keys(chat.userActivity || {}).filter(id => parseInt(id, 10) !== ctx.from.id);

    if (userIds.length === 0) {
        return ctx.reply("📢 В базе бота пока нет участников этого чата для созыва.");
    }

    let reasonText = ctx.message.text
        .replace(/^\/(all|everyone)|^@(all|everyone)/i, '')
        .trim();

    let header = `📣 <b>СОЗЫВ ВСЕХ УЧАСТНИКОВ!</b>\nОт: ${escapeHtml(ctx.from.first_name)}\n`;
    if (reasonText) {
        header += `💬 Сообщение: ${escapeHtml(reasonText)}\n`;
    }
    header += `\n`;

    let mentions = [];
    userIds.forEach(id => {
        const u = chat.userActivity[id];
        mentions.push(`<a href="tg://user?id=${id}">${escapeHtml(u.name)}</a>`);
    });

    const chunkSize = 30;
    for (let i = 0; i < mentions.length; i += chunkSize) {
        const chunk = mentions.slice(i, i + chunkSize);
        const messageText = (i === 0 ? header : "") + chunk.join(', ');
        await ctx.replyWithHTML(messageText).catch(err => {
            logger.error("Ошибка при отправке упоминаний:", err);
        });
    }
}

bot.command(['all', 'everyone'], handleCallEveryone);

// --- Управление фильтром запрещенных слов ---
bot.command('addword', async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ Ошибка: У вас нет прав для управления фильтром слов!");

    const word = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();
    if (!word) return ctx.replyWithHTML("⚠️ Укажите слово для добавления:\n<code>/addword слово</code>");

    if (dbData.config.badWords.includes(word)) {
        return ctx.replyWithHTML(`⚠️ Слово <code>${escapeHtml(word)}</code> уже есть в списке запрещённых!`);
    }

    dbData.config.badWords.push(word);
    saveDb();
    ctx.replyWithHTML(`✅ Слово <code>${escapeHtml(word)}</code> успешно добавлено в фильтр!`);
});

bot.command(['delword', 'removeword'], async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ Ошибка: У вас нет прав для управления фильтром слов!");

    const word = ctx.message.text.split(' ').slice(1).join(' ').trim().toLowerCase();
    if (!word) return ctx.replyWithHTML("⚠️ Укажите слово для удаления:\n<code>/delword слово</code>");

    const index = dbData.config.badWords.indexOf(word);
    if (index === -1) {
        return ctx.replyWithHTML(`⚠️ Слова <code>${escapeHtml(word)}</code> нет в списке запрещённых!`);
    }

    dbData.config.badWords.splice(index, 1);
    saveDb();
    ctx.replyWithHTML(`🗑️ Слово <code>${escapeHtml(word)}</code> удалено из фильтра!`);
});

bot.command(['badwords', 'words'], async (ctx) => {
    if (!await isAdmin(ctx, ctx.from.id)) return ctx.reply("⛔ Ошибка: Только администраторы могут просматривать список слов.");

    if (dbData.config.badWords.length === 0) {
        return ctx.reply("📜 Список запрещённых слов пуст.");
    }

    const wordsList = dbData.config.badWords.map(w => `• <code>${escapeHtml(w)}</code>`).join('\n');
    ctx.replyWithHTML(`🚫 <b>Список запрещённых слов (${dbData.config.badWords.length}):</b>\n\n${wordsList}`);
});

bot.help((ctx) => {
    ctx.reply(
`📚 Справка по командам и триггерам бота:

👤 Для всех участников:
• /start — Открыть главное меню в ЛС [Триггер: /start]
• /help — Показать эту справку [Триггер: /help]
• /rules — Просмотреть правила чата [Триггер: /rules]
• /me | /stats — Личная статистика и достижения [Триггеры: /me, /stats]
• /chatstats | /gstats — Статистика текущей группы [Триггеры: /chatstats, /gstats]
• /report — Пожаловаться на сообщение [Триггеры: /report, ответ словом «репорт» или «жалоба»]

⚙️ Управление чатом (для админов):
• /all <текст> | /everyone <текст> — Позвать всех участников чата [Триггеры: /all, /everyone, @all, @everyone]
• /setrules <текст> — Установить новые правила чата [Триггер: /setrules]
• /addword <слово> — Добавить слово в фильтр [Триггер: /addword]
• /delword <слово> — Удалить слово из фильтра [Триггеры: /delword, /removeword]
• /words — Посмотреть список запрещённых слов [Триггеры: /words, /badwords]

🛡️ Модерация (ответом на сообщение нарушителя):
• /warn — Выдать предупреждение [Триггеры: /warn, ответ словом «варн» или «warn»]
  └ 3 варна = МУТ на 7 дней, повторные 3 варна = БАН
• /unwarn — Снять предупреждение [Триггер: /unwarn]

• /mute <время> — Выдать мут [Триггеры: /mute, ответ словами «мут <время>»]
  └ Варианты и триггеры времени:
    • Минуты: /mute 10м | /mute 30 мин | мут 10м | мут 30 мин | мут 45 минут
    • Часы: /mute 1ч | /mute 2 часа | мут 1ч | мут 2 часа | мут 5 часов
    • Дни: /mute 1д | /mute 1 день | мут 1д | мут 1 день | мут 3д | мут 5 дней | мут 7 дней

• /unmute — Снять мут [Триггер: /unmute]
• /ban — Забанить пользователя [Триггер: /ban]
• /kick — Кикнуть пользователя из чата [Триггер: /kick]

💡 Интерактивное меню со статистикой и списком активных репортов доступно по кнопкам в ЛС бота (/start).`
    );
});

bot.command('rules', (ctx) => ctx.reply(dbData.config.rules));

bot.command('setrules', async (ctx) => {
    const userIsAdmin = await isAdmin(ctx, ctx.from.id);
    if (!userIsAdmin) return ctx.reply("⛔ Ошибка: У вас нет прав для изменения правил!");

    const newRules = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!newRules) return ctx.reply("⚠️ Укажите текст правил после команды /setrules");

    dbData.config.rules = `📜 Правила чата:\n${newRules}`;
    saveDb();
    ctx.reply("✅ Правила чата успешно обновлены!");
});

bot.command(['me', 'stats'], (ctx) => {
    const user = getUser(ctx.from.id, ctx.from.first_name);
    ctx.reply(buildPersonalStatsText(user));
});

bot.command(['chatstats', 'gstats'], (ctx) => {
    if (ctx.chat.type === 'private') {
        return ctx.reply("Для просмотра статистики групп используйте меню ЛС бота: /start");
    }
    const chat = getChatData(ctx.chat.id, ctx.chat.title);
    ctx.reply(buildGroupStatsText(chat));
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

    if (ctx.from.id !== reporterId) {
        return ctx.answerCbQuery("⛔ Вы не можете взаимодействовать с чужим репортом!", { show_alert: true });
    }

    const session = reportSessions.get(reporterId);
    if (!session) return ctx.answerCbQuery("Сессия репорта устарела.");

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

    if (ctx.from.id !== reporterId) {
        return ctx.answerCbQuery("⛔ Вы не можете взаимодействовать с чужим репортом!", { show_alert: true });
    }

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

    const reportText =
`⚠️ Новая жалоба! (Всего репортов: ${activeReportsForUser.length}/3)
💬 Чат: ${session.chatTitle}
👤 От: ${ctx.from.first_name} (ID: ${reporterId})
👥 На: ${session.reportedName} (ID: ${session.reportedId})
📌 Причина: ${session.reason}`;

    let sentCount = 0;
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
            sentCount++;
        } catch (e) {}
    }

    await ctx.editMessageText(
        sentCount > 0 
            ? `✅ Жалоба отправлена! На пользователя получено ${activeReportsForUser.length}/3 репортов.` 
            : `⚠️ Жалоба сохранена (${activeReportsForUser.length}/3). Администраторы уведомлены.`
    );

    reportSessions.delete(reporterId);
});

bot.action(/^rep_cancel_(\d+)$/, async (ctx) => {
    const reporterId = parseInt(ctx.match[1], 10);

    if (ctx.from.id !== reporterId) {
        return ctx.answerCbQuery("⛔ Вы не можете отменить чужой репорт!", { show_alert: true });
    }

    await ctx.answerCbQuery().catch(() => {});
    reportSessions.delete(reporterId);
    ctx.editMessageText("Отправка репорта отменена.").catch(() => {});
});

bot.action(/adm_dismiss_(.+)/, async (ctx) => {
    const repId = ctx.match[1];
    dbData.reports = dbData.reports.filter(r => r.id !== repId);
    saveDb();
    ctx.answerCbQuery("Репорт закрыт.");
});

bot.action(/adm_(warn|mute|ban)_(\d+)_(-?\d+)_(.+)/, async (ctx) => {
    const action = ctx.match[1];
    const targetId = parseInt(ctx.match[2]);
    const targetChatId = parseInt(ctx.match[3]);
    const repId = ctx.match[4];

    const adminCheck = await isAnywhereAdmin(ctx.telegram, ctx.from.id);
    if (!adminCheck) return ctx.answerCbQuery("⛔ Отказано в доступе!", { show_alert: true });

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
        ctx.answerCbQuery("Ошибка выполнения наказания.");
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
// 12. КАПЧА ПРИ ВХОДЕ
// ==============================================
bot.on('new_chat_members', async (ctx) => {
    if (!Config.GREETINGS.enabled) return;

    for (const member of ctx.message.new_chat_members) {
        if (member.is_bot && member.id === ctx.botInfo.id) continue;

        getUser(member.id, member.first_name);
        saveDb();

        const mention = `<a href="tg://user?id=${member.id}">${escapeHtml(member.first_name)}</a>`;

        if (Config.CAPTCHA.enabled) {
            try {
                await ctx.restrictChatMember(member.id, {
                    permissions: { can_send_messages: false, can_send_media_messages: false }
                });
            } catch (err) {}

            const captchaText = `👋 Добро пожаловать, ${mention}!\n\n🤖 Подтвердите, что вы не робот, нажав кнопку ниже в течение 3 минут:`;
            
            const captchaMessage = await ctx.replyWithHTML(captchaText, Markup.inlineKeyboard([
                [Markup.button.callback("🔘 Я не робот", `captcha_pass_${member.id}`)]
            ])).catch(() => null);

            if (captchaMessage) {
                const timer = setTimeout(async () => {
                    const sessionKey = `${ctx.chat.id}_${member.id}`;
                    if (pendingCaptchas.has(sessionKey)) {
                        try {
                            await ctx.telegram.banChatMember(ctx.chat.id, member.id);
                            await ctx.telegram.unbanChatMember(ctx.chat.id, member.id);
                            await ctx.telegram.deleteMessage(ctx.chat.id, captchaMessage.message_id).catch(() => {});
                        } catch (e) {}
                        pendingCaptchas.delete(sessionKey);
                    }
                }, Config.CAPTCHA.timeout_ms);

                pendingCaptchas.set(`${ctx.chat.id}_${member.id}`, { timer });
            }
        }
    }
});

bot.action(/^captcha_pass_(\d+)$/, async (ctx) => {
    const targetUserId = parseInt(ctx.match[1], 10);
    if (ctx.from.id !== targetUserId) {
        return ctx.answerCbQuery("⛔ Эта кнопка не для вас!", { show_alert: true });
    }

    const sessionKey = `${ctx.chat.id}_${targetUserId}`;
    if (pendingCaptchas.has(sessionKey)) {
        clearTimeout(pendingCaptchas.get(sessionKey).timer);
        pendingCaptchas.delete(sessionKey);
    }

    try {
        await ctx.restrictChatMember(targetUserId, {
            permissions: { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true }
        });
        await ctx.answerCbQuery("✅ Проверка пройдена!");
        await ctx.editMessageText(`✅ Проверка пройдена! Добро пожаловать, ${ctx.from.first_name}!`);
    } catch (e) {}
});

// ==============================================
// 13. ОСНОВНОЙ ФИЛЬТР И УЧЕТ СООБЩЕНИЙ
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
    updateRankScore(user);
    checkAchievements(user, ctx);

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

// ==============================================
// 14. ЗАПУСК И ОБРАБОТКА ОШИБОК
// ==============================================
loadDb();

bot.catch((err, ctx) => {
    logger.error(`Ошибка при обработке события ${ctx.updateType}:`, err);
});

bot.launch().then(() => logger.info('Бот запущен и готов к работе!'));

process.once('SIGINT', () => { saveDb(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { saveDb(); bot.stop('SIGTERM'); });
