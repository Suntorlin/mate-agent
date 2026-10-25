// One JSON object per line, with the time first, as the Node gateway logged; Workers Logs
// indexes the fields.
export type Log = (fields: Record<string, unknown>) => void;

export const log: Log = (fields) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), ...fields }));
