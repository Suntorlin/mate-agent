import { z } from "zod";
import { traceExportLineSchema } from "@open-inspect/shared/types/trace-export";
import { writeFileSync } from "node:fs";

writeFileSync(
  new URL("../../docs/schemas/trace-export.v2.schema.json", import.meta.url),
  JSON.stringify(z.toJSONSchema(traceExportLineSchema, { io: "input" }))
);
