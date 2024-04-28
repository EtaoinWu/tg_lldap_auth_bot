import { Bot, CommandContext, Context } from "grammy/mod.ts";
import { config, TgConfig } from "./config_utils.ts";
import { getLldapClient } from "./lldap.ts";
import { escapeHtml } from "https://deno.land/x/escape@1.4.2/mod.ts";

type MyCtx = Context;

type CommandInfo = {
  command: string;
  description: string;
  help_text: string;
  handler: (ctx: CommandContext<MyCtx>) => unknown;
};

const help_text = `Hi! This is Slice of Life's Authentication Bot.
I can help you register and authenticate users in ${config.help_text.login_url}.

Here are the available commands:
`;

class CommandArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandArgsError";
  }
}

class AuthBot {
  private token: string;
  private authorized_chats: Set<number>;
  private member_types: TgConfig["member_types"];
  private bot: Bot;
  private commands: CommandInfo[];
  private lldap_client;

  constructor(private config: TgConfig) {
    this.token = config.bot_token;
    this.authorized_chats = new Set(config.authorized_chats.map((x) => x.chat));
    this.member_types = config.member_types;

    this.lldap_client = getLldapClient();

    this.bot = new Bot(this.token, {
      client: {
        apiRoot: config.api_root,
      }
    });

    this.bot.catch((err) => {
      this.report_error(err);
    });

    this.commands = [
      {
        command: "help",
        description: "Get help",
        help_text: "without arguments",
        handler: (ctx) => ctx.reply(this.help_text()),
      },
      {
        command: "ping",
        description: "Check if the bot is alive",
        help_text: "without arguments",
        handler: (ctx) => ctx.reply("Pong!"),
      },
      {
        command: "chatid",
        description: "Get the ID of the current chat",
        help_text: "without arguments",
        handler: (ctx) => ctx.reply(`Chat ID: ${ctx.chat?.id}`),
      },
      {
        command: "mystatus",
        description: "Check your privilege status",
        help_text: "without arguments",
        handler: this.command_mystatus.bind(this),
      },
      {
        command: "register",
        description: "Register a new user (you probably want this)",
        help_text: "<username> <email>\n\n" +
          "Example: /register alice alice@example.com\n\n" +
          "Note: The username should have 3 to 32 characters and only contain letters, numbers, and underscores.\n" +
          "The email should be a valid email address that you will need to reset your password.",
        handler: this.command_register.bind(this),
      },
    ];

    for (const command of this.commands) {
      this.bot.command(command.command, async (ctx) => {
        try {
          await command.handler(ctx);
        } catch (err) {
          if (err instanceof CommandArgsError) {
            ctx.reply(
              `${err.message}\n\nUsage: /${command.command} ${command.help_text}`,
            );
          } else {
            // rethrow the error
            throw err;
          }
        }
      });
    }
  }

  report_message(message: string) {
    console.log(message);
    return this.bot.api.sendMessage(this.config.log_chat_id, message);
  }

  report_error(err: Error) {
    console.error(err);
    return this.bot.api.sendMessage(
      this.config.log_chat_id,
      `An error occurred: \n${err}`,
    );
  }

  help_text(): string {
    return help_text + this.commands.map((command) => {
      return `/${command.command} - ${command.description}`;
    }).join("\n");
  }

  async auth_status(ctx: CommandContext<MyCtx>): Promise<
    {
      status: "privileged";
      level: number;
      granting_chat: number;
      granting_chat_nickname: string;
    } | {
      status: "none";
    }
  > {
    const user = ctx.from;
    if (user === undefined) {
      return { status: "none" };
    }
    const chat = ctx.chat;
    if (chat === undefined) {
      return { status: "none" };
    }
    if (chat.type === "group" || chat.type === "supergroup") {
      const good_chat = this.config.authorized_chats.find(
        (x) => x.chat === chat.id,
      );
      if (good_chat === undefined) {
        return { status: "none" };
      }
      const member_info = await this.bot.api.getChatMember(chat.id, user.id);
      const level = this.member_types[member_info.status];
      return {
        status: "privileged",
        level,
        granting_chat: chat.id,
        granting_chat_nickname: good_chat.nickname,
      };
    }
    if (chat.type === "private") {
      let max_status = -1;
      let max_granted_chat = -1;
      let max_granted_chat_nickname = "";
      for (const chat of this.config.authorized_chats) {
        const member_info = await this.bot.api.getChatMember(
          chat.chat,
          user.id,
        );
        if (this.member_types[member_info.status] > max_status) {
          max_status = this.member_types[member_info.status];
          max_granted_chat = chat.chat;
          max_granted_chat_nickname = chat.nickname;
        }
      }
      if (max_status > 0) {
        return {
          status: "privileged",
          level: max_status,
          granting_chat: max_granted_chat,
          granting_chat_nickname: max_granted_chat_nickname,
        };
      }
    }
    return { status: "none" };
  }

  async command_mystatus(ctx: CommandContext<MyCtx>) {
    const status = await this.auth_status(ctx);
    if (status.status === "privileged") {
      ctx.reply(
        `You are privileged with level ${status.level} ` +
          `in chat <b>${status.granting_chat_nickname}</b>`,
          { parse_mode: "HTML" },
      );
    } else {
      ctx.reply("You are not privileged");
    }
  }

  async command_register(ctx: CommandContext<MyCtx>) {
    const user = ctx.from;
    if (user === undefined) {
      return ctx.reply("You are not identified as a telegram user");
    }
    const chat = ctx.chat;
    if (chat === undefined || chat.type !== "private") {
      throw new CommandArgsError("Use this command in a private chat.");
    }
    const status = await this.auth_status(ctx);
    if (status.status !== "privileged") {
      return ctx.reply("You are not privileged to use this command");
    }
    const args = ctx.message?.text?.split(" ");
    if (args === undefined || args.length !== 3) {
      throw new CommandArgsError("Invalid number of arguments");
    }
    const [_, username, email] = args;
    if (!username.match(/^[a-zA-Z0-9_]{3,32}$/)) {
      throw new CommandArgsError("Invalid username");
    }
    const email_regex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!email.match(email_regex)) {
      throw new CommandArgsError("Invalid email");
    }
    try {
      // check if user already exists
      const existing_user = await this.lldap_client.get_user_by_id(username);
      if (existing_user !== null) {
        ctx.reply(
          `User <b>${username}</b> already exists.`,
          { parse_mode: "HTML" },
        );
        return;
      }
      // check if this telegram account is already registered
      const existing_connect = await this.lldap_client.get_user_by_telegram_id(
        user.id.toString(),
      );
      if (existing_connect !== null) {
        ctx.reply(
          `This telegram account is already connected to user <b>${existing_connect}</b>.`,
          { parse_mode: "HTML" },
        );
        return;
      }
      // register the user
      await this.lldap_client.create_user(user.id.toString(), username, email);
      ctx.reply(
        `User <b>${username}</b> has been registered.\n\nPlease go to ${config.help_text.login_url} and use the "Reset Password" feature to set your password.`,
        { parse_mode: "HTML" },
      );
      this.report_message(
        `User <b>${username}</b> has been registered by ${escapeHtml(user.first_name)}(${user.id}) in chat ${chat.id}`,
      )
      await Promise.all(this.config.authorized_chats.map(async (chat) => {
        console.log(chat);
        const member_info = await this.bot.api.getChatMember(
          chat.chat,
          user.id,
        );
        console.log(member_info.status);
        if (this.member_types[member_info.status] <= 0) {
          return;
        }
        const ldap_group = chat.ldap_group_id;
        console.log(ldap_group);
        if (ldap_group === null) {
          return;
        }
        await this.lldap_client.add_to_group(username, ldap_group);
        await ctx.reply(
          `User <b>${username}</b> has been added to a group ` +
            `because you are in chat <b>${chat.nickname}</b>`,
          { parse_mode: "HTML" },
        );
      }));
    } catch (err) {
      ctx.reply(`LLDAP server had an error. Please contact the administrator.`);
      this.report_error(err);
    }
  }

  async start() {
    await this.bot.api.getMe();
    console.log("Bot is up and running");
    await this.bot.start();
  }
}

export function bot_main() {
  const bot = new AuthBot(config.tg);
  bot.start();
}
