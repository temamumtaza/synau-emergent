import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type McpTextResult = {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
};

type SnapTokenResult = {
  token?: unknown;
  redirect_url?: unknown;
};

function configuredEnvironment() {
  return process.env.SYNAU_MIDTRANS_PRODUCTION === 'true' ? 'production' : 'sandbox';
}

function stringEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in the backend environment.`);
  return value;
}

let midtransClientPromise: Promise<Client> | null = null;

async function getMidtransClient() {
  stringEnv('SYNAU_MIDTRANS_SERVER_KEY');
  if (!midtransClientPromise) {
    midtransClientPromise = (async () => {
      const packageEntry = path.resolve(process.cwd(), 'node_modules', '@theyahia', 'midtrans-mcp', 'dist', 'index.js');
      if (!fs.existsSync(packageEntry)) {
        throw new Error('Midtrans MCP package is not installed on the backend.');
      }
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [packageEntry],
        env: {
          PATH: process.env.PATH ?? '',
          MIDTRANS_SERVER_KEY: stringEnv('SYNAU_MIDTRANS_SERVER_KEY'),
          MIDTRANS_PRODUCTION: configuredEnvironment() === 'production' ? 'true' : 'false',
        },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'synau-backend', version: '0.1.0' }, { capabilities: {} });
      await client.connect(transport);
      return client;
    })().catch((error) => {
      midtransClientPromise = null;
      throw error;
    });
  }
  return midtransClientPromise;
}

async function callMidtransTool(name: string, args: Record<string, unknown>) {
  const client = await getMidtransClient();
  const result = await client.callTool({ name, arguments: args }) as McpTextResult;
  const text = result.content?.find((block) => block.type === 'text' && typeof block.text === 'string')?.text;
  if (result.isError || !text) {
    const detail = text?.replace(/\s+/g, ' ').slice(0, 280);
    throw new Error(`Midtrans MCP ${name} failed.${detail ? ` ${detail}` : ''}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Midtrans MCP ${name} returned invalid JSON.`);
  }
}

export async function createSnapToken(input: {
  orderId: string;
  grossAmount: number;
  customerName: string;
  customerEmail: string;
}) {
  const result = await callMidtransTool('create_snap_token', {
    order_id: input.orderId,
    gross_amount: input.grossAmount,
    customer_name: input.customerName,
    customer_email: input.customerEmail,
  }) as SnapTokenResult;
  if (typeof result.token !== 'string' || result.token.length === 0) {
    throw new Error('Midtrans did not return a Snap token.');
  }
  return {
    token: result.token,
    redirectUrl: typeof result.redirect_url === 'string' && result.redirect_url.length > 0 ? result.redirect_url : undefined,
  };
}

export async function getMidtransTransactionStatus(orderId: string) {
  return callMidtransTool('get_status', { order_id: orderId });
}

export function midtransClientKey() {
  return stringEnv('SYNAU_MIDTRANS_CLIENT_KEY');
}
