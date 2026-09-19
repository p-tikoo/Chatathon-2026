/**
 * GET /api/procedures  —  the CPT / RVU reference catalog
 *
 * Powers procedure autocomplete when adding a case, and lets a judge or a
 * reviewer inspect exactly what the objective complexity layer is built on.
 *
 * Query params:
 *   q            free-text search across name, CPT, specialty, keywords
 *   cpt          exact CPT lookup
 *   specialty    filter
 *   limit        default 20, max 100
 *
 * ⚠️  The RVU values in this catalog are APPROXIMATE and hand-entered for a
 *     demo. They preserve the correct relative ordering between procedures,
 *     which is all the fatigue model needs, but they are not authoritative and
 *     are not suitable for billing. The real source is the CMS Physician Fee
 *     Schedule Relative Value Files (free, updated annually):
 *     https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files
 *     See the header of lib/procedures.js.
 */

import { objectiveComplexity } from "@/lib/complexity.js";
import { handler, ok } from "@/lib/http.js";
import {
  getProcedureByCpt,
  listSpecialties,
  PROCEDURES,
  searchProcedures,
} from "@/lib/procedures.js";
import { asInt } from "@/lib/validate.js";

export const dynamic = "force-dynamic";

export const GET = handler(async (request) => {
  const url = new URL(request.url);
  const cpt = url.searchParams.get("cpt");
  const q = url.searchParams.get("q");
  const specialty = url.searchParams.get("specialty");
  const limit = asInt(url.searchParams.get("limit") ?? "20", "limit", { min: 1, max: 100 });

  if (cpt) {
    const procedure = getProcedureByCpt(cpt);
    if (!procedure) {
      return ok({ procedure: null, message: `CPT ${cpt} is not in the demo catalog.` });
    }
    return ok({
      procedure,
      complexity: objectiveComplexity({ cpt: procedure.cpt, procedure_name: procedure.name }),
      disclaimer: DISCLAIMER,
    });
  }

  let results = q ? searchProcedures(q, 100) : PROCEDURES;
  if (specialty) results = results.filter((p) => p.specialty === specialty);

  return ok({
    procedures: results.slice(0, limit).map((p) => ({
      ...p,
      complexity: objectiveComplexity({ cpt: p.cpt, procedure_name: p.name }),
    })),
    count: Math.min(results.length, limit),
    total_in_catalog: PROCEDURES.length,
    specialties: listSpecialties(),
    disclaimer: DISCLAIMER,
  });
});

const DISCLAIMER =
  "Work RVU and duration values are approximate, hand-entered demo data. They are not authoritative, not current-year verified, and not suitable for billing. Replace with the CMS Physician Fee Schedule Relative Value Files before any real use.";
