import { parse } from "https://esm.sh/yaml@2.4.1";
import * as y from "https://esm.sh/yup@1.4.0";

const configSchema = y.object({
  tg: y.object({
    bot_token: y.string().required(),
    api_root: y.string().url().default("https://api.telegram.org"),
    log_chat_id: y.number().required(),
    authorized_chats: y.array(y.object({
      chat: y.number().integer().required(),
      nickname: y.string().required(),
      ldap_group_id: y.number().integer().nullable().default(null),
    })).default([]),
    member_types: y.object({
      "creator": y.number().integer().default(-1),
      "administrator": y.number().integer().default(-1),
      "member": y.number().integer().default(-1),
      "restricted": y.number().integer().default(-1),
      "left": y.number().integer().default(-1),
      "kicked": y.number().integer().default(-1),
    }),
  }).required(),
  lldap_api: y.object({
    url_base: y.string().required(),
    username: y.string().required(),
    password: y.string().required(),
    relogin_time: y.number().default(6 * 60 * 60).positive().integer().min(
      15,
      "must be at least 15 seconds",
    ),
  }).required(),
  help_text: y.object({
    login_url: y.string().default("Your login URL"),
  }),
  enable_test_query: y.boolean().default(false),
});

export type Config = y.InferType<typeof configSchema>;
export type LldapConfig = Config["lldap_api"];
export type TgConfig = Config["tg"];

export const config: Config = await configSchema.validate(
  parse(await Deno.readTextFile("./config.yaml")),
);
