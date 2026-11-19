// Type declarations for the parts of the net-snmp package used by src/main/snmp.ts.
declare module 'net-snmp' {
  interface Varbind {
    oid: string;
    type: number;
    value: unknown;
  }

  interface SessionOptions {
    version?: number;
    timeout?: number;
    retries?: number;
    port?: number;
  }

  interface Session {
    get(oids: string[], callback: (error: Error | null, varbinds: Varbind[]) => void): void;
    getNext(oids: string[], callback: (error: Error | null, varbinds: Varbind[]) => void): void;
    subtree(
      oid: string,
      maxRepetitions: number,
      feed: (varbinds: Varbind[]) => boolean | void,
      done: (error: Error | null) => void,
    ): void;
    close(): void;
    on(event: 'error', listener: (error: Error) => void): void;
  }

  const snmp: {
    Version2c: number;
    ErrorStatus: { NoSuchName: number };
    /** No answer arrived after every try. */
    RequestTimedOutError: new (message: string) => Error;
    /** The agent answered with an error status. */
    RequestFailedError: new (message: string, status: number) => Error & { status: number };
    createSession(target: string, community: string, options?: SessionOptions): Session;
    isVarbindError(varbind: Varbind): boolean;
  };
  export default snmp;
  export type { Session, Varbind };
}
