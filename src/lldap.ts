import { config } from "./config_utils.ts";
import { LldapConfig } from "./config_utils.ts";
import { gql, GraphQLClient } from "https://esm.sh/graphql-request@6.1.0";
import { timeout } from "./timeout_util.ts";

export class AuthManager {
  private token: string | null = null;
  private login_endpoint: URL;

  constructor(private config: LldapConfig) {
    this.login_endpoint = new URL("/auth/simple/login", config.url_base);
  }

  getToken() {
    if (this.token === null) {
      throw new Error("Not logged in");
    }
    return this.token;
  }

  async login() {
    const res = await fetch(this.login_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: this.config.username,
        password: this.config.password,
      }),
    });
    if (!res.ok) {
      throw new Error("Failed to login");
    }
    const data = await res.json();
    this.token = data.token;
  }

  async login_loop(): Promise<never> {
    while (true) {
      await timeout(this.config.relogin_time * 1000);
      await this.login();
    }
  }
}

export type UserID = string;

export class LldapClient {
  private auth_manager: AuthManager;
  private gql_endpoint: URL;
  private gql_client: GraphQLClient;

  constructor(config: LldapConfig) {
    this.auth_manager = new AuthManager(config);
    this.gql_endpoint = new URL("/api/graphql", config.url_base);
    this.gql_client = new GraphQLClient(this.gql_endpoint.toString(), {
      headers: () => ({
        "Authorization": `Bearer ${this.auth_manager.getToken()}`,
      }),
    });
    this.auth_manager.login();
    this.auth_manager.login_loop();
  }

  async get_user_by_id(user_id: UserID): Promise<
    {
      id: UserID;
      telegram_id?: string;
      email: string;
    } | null
  > {
    const query = gql`
      query GetUserFromId($user_id: String!) {
        user(userId: $user_id) {
          id
          email
          attributes {
            name
            value
          }
        }
      }`;
    try {
      const res = await this.gql_client.request(query, { user_id }) as {
        user: {
          id: UserID;
          email: string;
          attributes: { name: string; value: string }[];
        };
      };
      const telegram_id = res.user.attributes.find(
        (attr) => attr.name === "telegram_id",
      )?.value;
      return {
        id: res.user.id,
        telegram_id,
        email: res.user.email,
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes("Entity not found")) {
        return null;
      }
      throw err;
    }
  }

  async get_user_by_telegram_id(telegram_id: string): Promise<UserID | null> {
    const query = gql`
      query GetUsersFromTelegramId($telegram_id: String!) {
        users(filters: {
          eq: {
            field: "telegram_id"
            value: $telegram_id
          }
        }) {
          id
        }
      }`;
    const res = await this.gql_client.request(query, { telegram_id }) as {
      users: { id: UserID }[];
    };
    if (res.users.length === 0) {
      return null;
    }
    return res.users[0].id;
  }

  async create_user(
    telegram_id: string,
    user_id: UserID,
    email: string,
  ): Promise<{
    uuid: string;
  }> {
    const mutation = gql`
      mutation CreateUser($telegram_id: String!, $user_id: String!, $email: String!) {
        createUser(user: {
          id: $user_id
          email: $email
          attributes: {
            name: "telegram_id"
            value: $telegram_id
          }
        }) {
          uuid
        }
      }`;
    const res = await this.gql_client.request(mutation, {
      telegram_id,
      user_id,
      email,
    }) as { createUser: { uuid: string } };
    return res.createUser;
  }

  async add_to_group(user_id: UserID, group_id: number): Promise<void> {
    const mutation = gql`
      mutation AddUserToGroup($user_id: String!, $group_id: Int!) {
        addUserToGroup(userId: $user_id, groupId: $group_id) {
          ok
        }
      }`;
    const res = await this.gql_client.request(mutation, {
      user_id,
      group_id,
    }) as { addUserToGroup: { ok: boolean } };
    if (!res.addUserToGroup.ok) {
      throw new Error(`Failed to add user ${user_id} to group ${group_id}`);
    }
  }
}

let lldap_client: LldapClient | null = null;

export function getLldapClient(): LldapClient {
  if (lldap_client === null) {
    lldap_client = new LldapClient(config.lldap_api);
  }
  return lldap_client;
}

export async function test_query() {
  if (config.enable_test_query === false) {
    return null;
  }
  const auth_manager = new AuthManager(config.lldap_api);
  await auth_manager.login();
  const gql_endpoint = new URL("/api/graphql", config.lldap_api.url_base);
  const gql_client = new GraphQLClient(gql_endpoint.toString(), {
    headers: () => ({ "Authorization": `Bearer ${auth_manager.getToken()}` }),
  });
  const query = gql`
  query GetUserFromId($user_id: String!) {
    user(userId: $user_id) {
      id
      email
      attributes {
        name
        value
      }
    }
  }`;
  const res = await gql_client.request(query, { user_id: "etaoin" }) as {
    user: {
      id: UserID;
      email: string;
      attributes: { name: string; value: string }[];
    };
  };
  return res;
}
