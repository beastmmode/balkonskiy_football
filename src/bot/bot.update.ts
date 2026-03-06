import { Logger } from '@nestjs/common';
import { Action, Command, Ctx, Help, Start, Update } from 'nestjs-telegraf';
import { Context, Markup } from 'telegraf';
import { Game, Participant } from '../types/game';
import { StorageService } from '../storage/storage.service';

@Update()
export class BotUpdate {
  private readonly logger = new Logger(BotUpdate.name);
  private readonly teamNamePool = ['Запад', 'Микраши', 'Золотой квадрат', 'БРГ'];
  private readonly faqText = [
    'FAQ для игроков',
    '',
    '1) Как записаться?',
    'Нажми кнопку своей команды под сообщением матча.',
    '',
    '2) Как понять, что я записан?',
    'Твой ник появится в списке команды.',
    '',
    '3) Что значит ✅ возле ника?',
    'Ты отметил, что оплатил.',
    '',
    '4) Что значит ⚠️ возле ника?',
    'Ты отметил: может не прийти.',
    '',
    '5) Как отметить оплату?',
    'После записи бот присылает реквизиты в ЛС. Нажми кнопку "✅ Оплатил".',
    '',
    '6) Как поставить/убрать "может не приду"?',
    'В ЛС нажми кнопку "❓ Может не приду". Повторное нажатие снимает статус.',
    '',
    '7) Не приходит сообщение в ЛС от бота',
    'Открой бота, нажми /start, затем снова нажми кнопку команды в группе.',
    '',
    '8) Как отменить участие?',
    'Нажми "❌ Отменить запись" под сообщением матча.',
    '',
    '9) Как перейти в другую команду?',
    'Сначала отмени запись, затем нажми кнопку другой команды.',
    '',
    '10) Почему не дает записаться?',
    'Либо общий состав заполнен, либо в выбранной команде уже 5/5.',
  ].join('\n');

  constructor(private readonly storageService: StorageService) {}

  @Start()
  async onStart(@Ctx() ctx: Context): Promise<void> {
    if (!(await this.isAdminCommand(ctx))) {
      return;
    }
    await ctx.reply(
      [
        'Бот для организации футбола в группе.',
        '',
        'Создать игру:',
        '/new 2026-03-08 | 20:00 | Арена Юг-2 | 20 | 400 сом | 0555xxxxxx (МБанк)',
        '/new 2026-03-08 | 20:00 | Арена Юг-2 | 15 | 400 сом | 0555xxxxxx (МБанк)',
        '',
        'Очистить игры в чате:',
        '/clear',
        '',
        'В группе у игроков будут кнопки команд, после записи бот обновляет закрепленное сообщение.',
      ].join('\n'),
    );
  }

  @Help()
  async onHelp(@Ctx() ctx: Context): Promise<void> {
    if (!(await this.isAdminCommand(ctx))) {
      return;
    }
    await this.onStart(ctx);
  }

  @Command('faq')
  async onFaq(@Ctx() ctx: Context): Promise<void> {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Напишите боту в ЛС и отправьте команду /faq');
      return;
    }
    await ctx.reply(this.faqText);
  }

  @Command('new')
  async onNewGame(@Ctx() ctx: Context): Promise<void> {
    const isAdmin = await this.isAdminCommand(ctx);
    if (!isAdmin) {
      await ctx.reply('Только администратор группы может создавать игру.');
      return;
    }

    const msg = ctx.message;
    if (!msg || !('text' in msg)) {
      return;
    }

    const payload = msg.text.replace('/new', '').trim();
    const parsed = this.parseNewGamePayload(payload);
    if (!parsed.ok) {
      await ctx.reply(parsed.error);
      return;
    }

    const chatId = ctx.chat?.id;
    const authorId = ctx.from?.id;
    if (!chatId || !authorId) {
      return;
    }

    const game: Game = {
      id: `${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      chatId,
      messageId: 0,
      createdBy: authorId,
      createdAt: new Date().toISOString(),
      date: parsed.date,
      time: parsed.time,
      location: parsed.location,
      slots: parsed.slots,
      price: parsed.price,
      requisites: parsed.requisites,
      teamNames: this.getTeamNamesBySlots(parsed.slots),
      participants: [],
    };

    const db = await this.storageService.readDb();
    db.games.push(game);
    await this.storageService.writeDb(db);

    const sent = await ctx.reply(
      this.renderGameText(game),
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(this.buildGameKeyboard(game)),
      },
    );

    try {
      await ctx.telegram.pinChatMessage(chatId, sent.message_id, { disable_notification: true });
    } catch (error) {
      this.logger.warn(`Could not pin game message in chat ${chatId}`);
    }

    const latest = await this.storageService.readDb();
    const index = latest.games.findIndex((g) => g.id === game.id);
    if (index >= 0) {
      latest.games[index].messageId = sent.message_id;
      await this.storageService.writeDb(latest);
    }
  }

  @Command('clear')
  async onClearGames(@Ctx() ctx: Context): Promise<void> {
    const isAdmin = await this.isAdminCommand(ctx);
    if (!isAdmin) {
      await ctx.reply('Только администратор группы может очищать игры.');
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const db = await this.storageService.readDb();
    const before = db.games.length;
    db.games = db.games.filter((game) => game.chatId !== chatId);
    const removed = before - db.games.length;
    await this.storageService.writeDb(db);

    await ctx.reply(`Удалено игр: ${removed}`);
  }

  @Action(/^(join_team|leave):/)
  async onGameAction(@Ctx() ctx: Context): Promise<void> {
    const callback = ctx.callbackQuery;
    if (!callback || !('data' in callback)) {
      return;
    }

    const [action, gameId, teamIndexRaw] = callback.data.split(':');
    if (!gameId || (action !== 'join_team' && action !== 'leave')) {
      await ctx.answerCbQuery('Некорректная команда');
      return;
    }

    const user = ctx.from;
    if (!user) {
      return;
    }

    const db = await this.storageService.readDb();
    const game = db.games.find((item) => item.id === gameId);
    if (!game) {
      await ctx.answerCbQuery('Игра не найдена');
      return;
    }
    this.normalizeGame(game);

    if (action === 'join_team') {
      const teamIndex = Number(teamIndexRaw);
      if (!Number.isInteger(teamIndex) || teamIndex < 0 || teamIndex >= game.teamNames.length) {
        await ctx.answerCbQuery('Не удалось определить команду');
        return;
      }

      const alreadyJoined = game.participants.some((p) => p.userId === user.id);
      if (alreadyJoined) {
        await ctx.answerCbQuery('Вы уже записаны');
        return;
      }
      if (game.participants.length >= game.slots) {
        await ctx.answerCbQuery('Мест больше нет');
        return;
      }
      const teamMembers = game.participants.filter((p) => p.teamIndex === teamIndex);
      if (teamMembers.length >= 5) {
        await ctx.answerCbQuery('В этой команде уже 5 игроков');
        return;
      }

      const participant: Participant = {
        userId: user.id,
        username: user.username,
        firstName: user.first_name,
        teamIndex,
        paid: false,
        tentative: false,
        joinedAt: new Date().toISOString(),
      };
      game.participants.push(participant);
      await this.storageService.writeDb(db);

      await ctx.answerCbQuery('Вы записаны');
      await this.sendRequisites(ctx, game, user.id);
      await this.refreshGameMessage(ctx, game);
      return;
    }

    const beforeMain = game.participants.length;
    game.participants = game.participants.filter((p) => p.userId !== user.id);
    if (beforeMain === game.participants.length) {
      await ctx.answerCbQuery('Вас нет в списке');
      return;
    }
    await this.storageService.writeDb(db);
    await ctx.answerCbQuery('Вы удалены из игры');
    await this.refreshGameMessage(ctx, game);
  }

  @Action(/^paid:/)
  async onPaidAction(@Ctx() ctx: Context): Promise<void> {
    const callback = ctx.callbackQuery;
    if (!callback || !('data' in callback)) {
      return;
    }

    const [, gameId] = callback.data.split(':');
    if (!gameId) {
      await ctx.answerCbQuery('Некорректная команда');
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) {
      return;
    }

    const db = await this.storageService.readDb();
    const game = db.games.find((item) => item.id === gameId);
    if (!game) {
      await ctx.answerCbQuery('Игра не найдена');
      return;
    }
    this.normalizeGame(game);

    const participant = game.participants.find((p) => p.userId === userId);
    if (!participant) {
      await ctx.answerCbQuery('Вы не записаны на эту игру');
      return;
    }

    if (participant.paid) {
      await ctx.answerCbQuery('Уже отмечено');
      return;
    }

    participant.paid = true;
    participant.paidAt = new Date().toISOString();
    participant.tentative = false;
    participant.tentativeAt = undefined;
    await this.storageService.writeDb(db);
    await ctx.answerCbQuery('Оплата отмечена');
    await this.refreshGameMessage(ctx, game);
  }

  @Action(/^tentative:/)
  async onTentativeAction(@Ctx() ctx: Context): Promise<void> {
    const callback = ctx.callbackQuery;
    if (!callback || !('data' in callback)) {
      return;
    }

    const [, gameId] = callback.data.split(':');
    if (!gameId) {
      await ctx.answerCbQuery('Некорректная команда');
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) {
      return;
    }

    const db = await this.storageService.readDb();
    const game = db.games.find((item) => item.id === gameId);
    if (!game) {
      await ctx.answerCbQuery('Игра не найдена');
      return;
    }
    this.normalizeGame(game);

    const participant = game.participants.find((p) => p.userId === userId);
    if (!participant) {
      await ctx.answerCbQuery('Вы не записаны на эту игру');
      return;
    }

    if (participant.paid) {
      await ctx.answerCbQuery('Вы оплатили, статус менять нельзя');
      return;
    }

    participant.tentative = !participant.tentative;
    participant.tentativeAt = participant.tentative ? new Date().toISOString() : undefined;
    await this.storageService.writeDb(db);
    await ctx.answerCbQuery(participant.tentative ? 'Отмечено: может не прийти' : 'Метка снята');
    await this.refreshGameMessage(ctx, game);
  }

  private async sendRequisites(ctx: Context, game: Game, userId: number): Promise<void> {
    try {
      await ctx.telegram.sendMessage(
        userId,
        [`Вы записаны на игру ${game.date} ${game.time}.`, '', `Реквизиты для оплаты:`, game.requisites].join(
          '\n',
        ),
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Оплатил', `paid:${game.id}`)],
          [Markup.button.callback('⚠️ Может не приду', `tentative:${game.id}`)],
        ]),
      );
    } catch (error) {
      this.logger.warn(`Could not send requisites to user ${userId}`);
      const botUsername = ctx.botInfo?.username;
      await ctx.reply(
        botUsername
          ? `@${ctx.from?.username ?? 'игрок'}, откройте ЛС с ботом @${botUsername} и нажмите /start, чтобы получить реквизиты.`
          : `@${ctx.from?.username ?? 'игрок'}, откройте ЛС с ботом через /start, чтобы получить реквизиты.`,
      );
    }
  }

  private async refreshGameMessage(ctx: Context, game: Game): Promise<void> {
    if (!game.messageId) {
      return;
    }

    try {
      await ctx.telegram.editMessageText(
        game.chatId,
        game.messageId,
        undefined,
        this.renderGameText(game),
        {
          parse_mode: 'HTML',
          reply_markup: Markup.inlineKeyboard(this.buildGameKeyboard(game)).reply_markup,
        },
      );
    } catch (error) {
      this.logger.warn(`Failed to edit game message ${game.messageId} in chat ${game.chatId}`);
    }
  }

  private renderGameText(game: Game): string {
    const teamCount = game.teamNames.length;
    const lines = [
      `📅 Дата: ${game.date}`,
      `🕒 Время: ${game.time}`,
      `📍 Поле: ${game.location}`,
      `👥 Формат: ${game.slots} игроков (${teamCount} команд по 5)`,
      `💰 Взнос: ${game.price}`,
      '',
      `📊 Записано: ${game.participants.length}/${game.slots}`,
    ];
    lines.push('');
    lines.push('🧩 Составы:');
    game.teamNames.forEach((teamName, index) => {
      const players = game.participants.filter((p) => p.teamIndex === index);
      lines.push(`<b>${this.escapeHtml(teamName)}</b> [${players.length}/5]`);
      if (players.length === 0) {
        lines.push('• Пусто');
      } else {
        players.forEach((player) => lines.push(`• ${this.participantName(player)}`));
      }
      lines.push('');
    });

    if (game.participants.length === game.slots) {
      lines.push('🏁 Порядок игр:');
      this.buildMatchOrder(game.teamNames).forEach((match, index) => {
        lines.push(`${index + 1}. ${match}`);
      });
      lines.push('');
    }

    lines.push('Статусы: ✅ оплатил, ⚠️ может не прийти');

    return lines.join('\n');
  }

  private participantName(participant: Participant): string {
    const paidMark = participant.paid ? '✅ ' : '';
    const tentativeMark = !participant.paid && participant.tentative ? '⚠️ ' : '';
    const prefix = paidMark || tentativeMark;
    if (participant.username) {
      return `${prefix}@${participant.username}`;
    }
    if (participant.firstName) {
      return `${prefix}${this.escapeHtml(participant.firstName)}`;
    }
    return `${prefix}id:${participant.userId}`;
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  private parseNewGamePayload(payload: string):
    | {
        ok: true;
        date: string;
        time: string;
        location: string;
        slots: number;
        price: string;
        requisites: string;
      }
    | { ok: false; error: string } {
    const parts = payload.split('|').map((value) => value.trim());
    if (parts.length !== 6) {
      return {
        ok: false,
        error:
          'Формат: /new YYYY-MM-DD | HH:mm | Поле | 15 или 20 | Цена (например 400 сом) | Реквизиты',
      };
    }

    const [date, time, location, slotsRaw, price, requisites] = parts;
    const slots = Number(slotsRaw);
    if (!Number.isInteger(slots) || slots <= 0) {
      return { ok: false, error: 'Количество игроков должно быть целым числом.' };
    }
    if (slots !== 15 && slots !== 20) {
      return { ok: false, error: 'Поддерживается формат только 15 или 20 игроков.' };
    }

    if (!date || !time || !location || !price || !requisites) {
      return { ok: false, error: 'Все поля обязательны.' };
    }

    return {
      ok: true,
      date,
      time,
      location,
      slots,
      price,
      requisites,
    };
  }

  private getTeamNamesBySlots(slots: number): string[] {
    return this.teamNamePool.slice(0, slots / 5);
  }

  private buildMatchOrder(teamNames: string[]): string[] {
    const namedTeams = teamNames.map((name) => `Команда ${name}`);
    if (namedTeams.length === 3) {
      return [
        `${namedTeams[0]} vs ${namedTeams[1]}`,
        `${namedTeams[2]} vs Победитель матча 1`,
        `${namedTeams[0]} vs ${namedTeams[2]} (если нужно решать по кругу)`,
      ];
    }
    return [
      `${namedTeams[0]} vs ${namedTeams[1]}`,
      `${namedTeams[2]} vs ${namedTeams[3]}`,
      'Победитель матча 1 vs Победитель матча 2',
    ];
  }

  private buildGameKeyboard(game: Game): ReturnType<typeof Markup.button.callback>[][] {
    const teamButtons = game.teamNames.map((name, index) => {
      const count = game.participants.filter((p) => p.teamIndex === index).length;
      return Markup.button.callback(`${name} (${count}/5)`, `join_team:${game.id}:${index}`);
    });
    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let i = 0; i < teamButtons.length; i += 2) {
      rows.push(teamButtons.slice(i, i + 2));
    }
    rows.push([Markup.button.callback('❌ Отменить запись', `leave:${game.id}`)]);
    return rows;
  }

  private normalizeGame(game: Game): void {
    game.participants = game.participants.map((player) => ({
      ...player,
      paid: Boolean(player.paid),
      tentative: Boolean(player.tentative),
    }));
  }

  private async isAdminCommand(ctx: Context): Promise<boolean> {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    if (!chatId || !userId) {
      return false;
    }

    if (ctx.chat?.type === 'private') {
      return true;
    }

    try {
      const member = await ctx.telegram.getChatMember(chatId, userId);
      return member.status === 'administrator' || member.status === 'creator';
    } catch {
      return false;
    }
  }
}
