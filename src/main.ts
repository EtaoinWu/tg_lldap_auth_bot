import { bot_main } from "./bot.ts";
import { test_query } from "./lldap.ts";

bot_main();
console.log("Test query:", await test_query())
