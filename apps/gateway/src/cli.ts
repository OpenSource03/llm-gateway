#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { GatewayAdminClient } from "@opensource03/llm-gateway-admin-client";
import { controlScopes } from "@opensource03/llm-gateway-contracts";
import { Command } from "commander";

const program = new Command()
  .name("llmgw")
  .description("Operate a self-hosted LLM Gateway")
  .version("0.1.0");

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const writeOneTimeSecret = async (
  secret: string,
  outputFile: string | undefined,
): Promise<void> => {
  if (outputFile) {
    await writeFile(outputFile, `${secret}\n`, { mode: 0o600, flag: "wx" });
    await chmod(outputFile, 0o600);
    process.stdout.write(`Control key written to ${outputFile}\n`);

    return;
  }
  if (!process.stdout.isTTY) {
    throw new Error(
      "Refusing to print a one-time key to non-interactive output; use --output-file",
    );
  }

  process.stdout.write(`${secret}\n`);
};

const controlKeys = program
  .command("control-keys")
  .description("Manage control-plane keys");
let usedLocalDatabase = false;

const localControlKeys = async () => {
  usedLocalDatabase = true;

  return import("./control/control-keys.service");
};

controlKeys
  .command("create")
  .requiredOption("--name <name>")
  .requiredOption("--owner <label>")
  .option("--scope <scope...>", "Control scopes", [...controlScopes])
  .option("--cidr <cidr...>", "Allowed client CIDRs", [])
  .option(
    "--delegate-actors",
    "Allow a trusted BFF to supply actor identity",
    false,
  )
  .option("--expires-in-days <days>", "Expiration in days", Number)
  .option(
    "--output-file <path>",
    "Create an owner-only file for the one-time key",
  )
  .action(async (options) => {
    const { createControlKey } = await localControlKeys();
    const created = await createControlKey(null, {
      name: options.name as string,
      owner_label: options.owner as string,
      scopes: options.scope,
      allowed_cidrs: options.cidr,
      can_delegate_actors: options.delegateActors as boolean,
      expires_in_days: options.expiresInDays ?? null,
    });

    await writeOneTimeSecret(created.key, options.outputFile);
  });

controlKeys.command("list").action(async () => {
  const { listControlKeys } = await localControlKeys();

  process.stdout.write(`${JSON.stringify(await listControlKeys(), null, 2)}\n`);
});

controlKeys
  .command("revoke")
  .argument("<id>")
  .action(async (id: string) => {
    const { revokeControlKey } = await localControlKeys();

    process.stdout.write(
      `${JSON.stringify(await revokeControlKey(id), null, 2)}\n`,
    );
  });

const remoteClient = (options: {
  controlUrl?: string;
  controlKeyFile?: string;
}) => {
  const baseUrl = options.controlUrl ?? process.env.LLM_GATEWAY_CONTROL_URL;

  if (!baseUrl) throw new Error("Set LLM_GATEWAY_CONTROL_URL");

  return new GatewayAdminClient({
    baseUrl,
    apiKey: async () => {
      const key = options.controlKeyFile
        ? (await readFile(options.controlKeyFile, "utf8")).trim()
        : process.env.LLM_GATEWAY_CONTROL_KEY;

      if (!key) {
        throw new Error(
          "Set LLM_GATEWAY_CONTROL_KEY or pass --control-key-file",
        );
      }

      return key;
    },
  });
};

program
  .command("status")
  .option("--control-url <url>")
  .option("--control-key-file <path>")
  .action(async (options) => {
    process.stdout.write(
      `${JSON.stringify(await remoteClient(options).status(), null, 2)}\n`,
    );
  });

const accountsCommand = program
  .command("accounts")
  .option("--control-url <url>")
  .option("--control-key-file <path>")
  .action(async (options) => {
    process.stdout.write(
      `${JSON.stringify(await remoteClient(options).listAccounts(), null, 2)}\n`,
    );
  });

accountsCommand
  .command("add-oauth-token")
  .requiredOption("--name <label>")
  .option("--transport <transport>", "direct or agent-sdk", "direct")
  .option("--token-stdin", "Read the OAuth token from stdin")
  .action(async (options, command) => {
    if (!["direct", "agent-sdk"].includes(options.transport))
      throw new Error("Invalid transport");
    let token = "";
    if (options.tokenStdin) {
      for await (const chunk of process.stdin) {
        token += chunk.toString();
        if (token.length > 4096) throw new Error("Token is too long");
      }
    } else {
      if (!process.stdin.isTTY)
        throw new Error("Use --token-stdin for noninteractive input");
      process.stderr.write("Claude OAuth token (hidden): ");
      const wasRaw = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      try {
        token = await new Promise<string>((resolve, reject) => {
          let value = "";
          const onData = (chunk: Buffer) => {
            for (const character of chunk.toString()) {
              if (character === "\u0003") {
                cleanup();
                reject(new Error("Cancelled"));
                return;
              }
              if (character === "\r" || character === "\n") {
                cleanup();
                resolve(value);
                return;
              }
              if (character === "\u007f" || character === "\b")
                value = value.slice(0, -1);
              else if (character >= " ") value += character;
              if (value.length > 4096) {
                cleanup();
                reject(new Error("Token is too long"));
                return;
              }
            }
          };
          const cleanup = () => process.stdin.off("data", onData);
          process.stdin.on("data", onData);
        });
      } finally {
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
        process.stderr.write("\n");
      }
    }
    try {
      const result = await remoteClient(
        command.optsWithGlobals(),
      ).createOAuthToken({
        provider: "anthropic",
        token: token.trim(),
        display_name: options.name,
        transport: options.transport,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      // Clear the reference when the request ends, including on failure.
      // eslint-disable-next-line no-useless-assignment
      token = "";
    }
  });

program
  .command("models")
  .option("--control-url <url>")
  .option("--control-key-file <path>")
  .action(async (options) => {
    process.stdout.write(
      `${JSON.stringify(await remoteClient(options).listModels(), null, 2)}\n`,
    );
  });

program
  .command("provider-login")
  .argument("<provider>")
  .option("--control-url <url>")
  .option("--control-key-file <path>")
  .option("--no-wait", "Start the flow without completing or polling it")
  .action(async (provider: string, options) => {
    const client = remoteClient(options);
    const attempt = await client.startOAuth(provider);

    process.stdout.write(`${JSON.stringify(attempt, null, 2)}\n`);
    if (!options.wait) return;

    if (attempt.flow === "AUTHORIZATION_CODE") {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stdout.write(
          "Complete this attempt through the control API or an integrating dashboard.\n",
        );

        return;
      }
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        const authorizationCode = (
          await prompt.question("Paste the displayed authorization code: ")
        ).trim();

        if (!authorizationCode) throw new Error("Authorization code required");
        const completed = await client.completeOAuth(
          attempt.id,
          authorizationCode,
        );

        process.stdout.write(`${JSON.stringify(completed, null, 2)}\n`);
      } finally {
        prompt.close();
      }

      return;
    }

    const expiresAt = Date.parse(attempt.expiresAt);
    const pollIntervalMs = Math.max(
      1_000,
      (attempt.pollingIntervalSeconds ?? 5) * 1_000,
    );

    while (Date.now() < expiresAt) {
      await wait(pollIntervalMs);
      const progress = await client.pollOAuthAttempt(attempt.id);

      if (progress.status === "PENDING") continue;
      process.stdout.write(`${JSON.stringify(progress, null, 2)}\n`);
      if (progress.status !== "AUTHORIZED") {
        throw new Error(
          `Provider authentication ended with status ${progress.status}`,
        );
      }

      return;
    }

    throw new Error("Provider authentication expired before completion");
  });

program.command("rewrap-keys").action(async () => {
  usedLocalDatabase = true;
  const { rewrapGatewayKeys } = await import("./core/security/rewrap");
  const result = await rewrapGatewayKeys();

  process.stdout.write(
    `Rewrapped ${result.credentials} credential(s) and ${result.oauthAttempts} OAuth attempt(s) to ${result.keyWrapperId}\n`,
  );
});

void program
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Command failed"}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (usedLocalDatabase) {
      const { closeLlmGatewayDatabase } = await import("./core/db");

      await closeLlmGatewayDatabase();
    }
  });
