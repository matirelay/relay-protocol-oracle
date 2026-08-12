import {
  createPublicClient,
  Hex,
  PublicClient,
  webSocket,
  WebSocketTransport,
} from "viem";

export type EventLog = {
  address: string;
  blockNumber?: Hex;
  data: Hex;
  logIndex?: Hex;
  removed?: boolean;
  topics: [Hex, ...Hex[]];
  transactionHash?: Hex;
};

type LogSubscription = {
  address: `0x${string}`;
  topics: [Hex, ...Hex[]];
  onLog: (log: EventLog) => void;
  onError: (error: unknown) => void;
};

export interface EventConnection {
  getChainId(): Promise<number>;
  subscribeLogs(subscription: LogSubscription): Promise<() => void>;
  close(): Promise<void>;
}

type WebSocketClient = PublicClient<
  WebSocketTransport,
  undefined,
  undefined,
  undefined
>;

class ViemEventConnection implements EventConnection {
  public constructor(private readonly client: WebSocketClient) {}

  public getChainId(): Promise<number> {
    return this.client.getChainId();
  }

  public async subscribeLogs({
    address,
    topics,
    onLog,
    onError,
  }: LogSubscription): Promise<() => void> {
    const subscription = await this.client.transport.subscribe({
      params: ["logs", { address, topics }],
      onData: (data) => {
        const log = (data as { result?: EventLog }).result;
        if (log) {
          onLog(log);
        }
      },
      onError,
    });

    return () => {
      void subscription.unsubscribe().catch(onError);
    };
  }

  public async close(): Promise<void> {
    const rpcClient = await this.client.transport.getRpcClient();
    rpcClient.close();
  }
}

export const createEventConnection = (url: string): EventConnection => {
  const client = createPublicClient({
    transport: webSocket(url, {
      keepAlive: false,
      reconnect: false,
      retryCount: 0,
      timeout: 10_000,
    }),
  });
  return new ViemEventConnection(client);
};
