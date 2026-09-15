export interface CypherConfig {
  base: string;
  user: string;
  password: string;
}

export interface Row {
  [column: string]: unknown;
}

export class Cypher {
  #base: string;
  #auth: string;

  constructor(cfg: CypherConfig) {
    this.#base = cfg.base.replace(/\/+$/, "");
    this.#auth = "Basic " + btoa(`${cfg.user}:${cfg.password}`);
  }

  async run(statement: string, parameters: Record<string, unknown> = {}): Promise<Row[]> {
    const res = await fetch(`${this.#base}/db/neo4j/tx/commit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": this.#auth,
      },
      body: JSON.stringify({ statements: [{ statement, parameters }] }),
    });
    if (!res.ok) {
      throw new Error(`neo4j HTTP ${res.status}`);
    }
    const body = await res.json();
    if (body.errors && body.errors.length) {
      throw new Error(body.errors[0].message);
    }
    const result = body.results?.[0];
    if (!result) return [];
    const { columns, data } = result;
    return data.map((d: { row: unknown[] }) => {
      const o: Row = {};
      columns.forEach((c: string, i: number) => {
        o[c] = d.row[i];
      });
      return o;
    });
  }
}
