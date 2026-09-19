/**
 * CPT / RVU PROCEDURE CATALOG
 * ============================================================================
 * This is the objective layer of case difficulty. It removes the "difficulty
 * is subjective" problem by anchoring to a measure hospitals already compute
 * for every single case: the work RVU.
 *
 * WHAT AN RVU IS (for the pitch — judges will ask):
 *   Under the US Medicare Physician Fee Schedule, every procedure has a CPT
 *   code, and every CPT code carries a Relative Value Unit breakdown:
 *     - work RVU (wRVU)        -> physician time, technical skill, mental
 *                                 effort, judgment, and stress. This is the
 *                                 component we use.
 *     - practice expense RVU   -> overhead. Irrelevant here.
 *     - malpractice RVU        -> liability. Irrelevant here.
 *   The wRVU is literally the health system's own standardized estimate of how
 *   demanding a procedure is for the surgeon. It is already in every hospital's
 *   billing system. We are not inventing a difficulty scale — we are reusing
 *   the one that already exists and has been maintained by CMS and the AMA
 *   RUC for decades.
 *
 * ⚠️  ACCURACY DISCLAIMER — READ BEFORE QUOTING THESE NUMBERS
 *   The wRVU values below are APPROXIMATE, rounded, and were entered by hand
 *   for a hackathon demo. They are the right order of magnitude and preserve
 *   the correct RELATIVE ordering between procedures (which is all the fatigue
 *   model needs), but they are NOT authoritative and some may be off by a
 *   meaningful margin. Values also change annually.
 *
 *   Do NOT present these as exact. Before any real use, replace this table by
 *   loading the official source:
 *     CMS Physician Fee Schedule Relative Value Files (free, updated yearly)
 *     https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files
 *   That download is a CSV with every CPT code and its current wRVU. Swapping
 *   this file for a real import is a ~20 line change and is on the roadmap.
 *
 *   `typical_duration_hrs` is likewise an approximate institutional average —
 *   real operative times vary enormously by patient, surgeon, and facility.
 * ============================================================================
 */

/**
 * @typedef {Object} Procedure
 * @property {string} cpt                  CPT code
 * @property {string} name                 Human-readable procedure name
 * @property {string} specialty            Owning surgical specialty
 * @property {number} work_rvu             Approximate work RVU (see disclaimer)
 * @property {number} typical_duration_hrs Approximate operative time
 * @property {string[]} keywords           Free-text match aids
 */

/** @type {Procedure[]} */
export const PROCEDURES = [
  // --- General surgery ------------------------------------------------------
  { cpt: "44970", name: "Laparoscopic appendectomy", specialty: "General Surgery", work_rvu: 9.5, typical_duration_hrs: 1.0, keywords: ["appendectomy", "appy", "appendix", "lap appy"] },
  { cpt: "47562", name: "Laparoscopic cholecystectomy", specialty: "General Surgery", work_rvu: 10.5, typical_duration_hrs: 1.3, keywords: ["cholecystectomy", "gallbladder", "lap chole"] },
  { cpt: "47600", name: "Open cholecystectomy", specialty: "General Surgery", work_rvu: 15.4, typical_duration_hrs: 2.0, keywords: ["open cholecystectomy", "open gallbladder"] },
  { cpt: "49505", name: "Open inguinal hernia repair, initial, age 5+", specialty: "General Surgery", work_rvu: 7.9, typical_duration_hrs: 1.2, keywords: ["hernia", "inguinal", "herniorrhaphy"] },
  { cpt: "49650", name: "Laparoscopic inguinal hernia repair, initial", specialty: "General Surgery", work_rvu: 9.4, typical_duration_hrs: 1.3, keywords: ["lap hernia", "laparoscopic hernia"] },
  { cpt: "44140", name: "Partial colectomy with anastomosis, open", specialty: "General Surgery", work_rvu: 22.5, typical_duration_hrs: 3.0, keywords: ["colectomy", "colon resection", "hemicolectomy"] },
  { cpt: "44204", name: "Laparoscopic partial colectomy with anastomosis", specialty: "General Surgery", work_rvu: 24.0, typical_duration_hrs: 3.5, keywords: ["lap colectomy", "laparoscopic colon"] },
  { cpt: "44120", name: "Small intestine resection, single", specialty: "General Surgery", work_rvu: 19.0, typical_duration_hrs: 2.5, keywords: ["small bowel resection", "enterectomy"] },
  { cpt: "49000", name: "Exploratory laparotomy", specialty: "Trauma Surgery", work_rvu: 15.6, typical_duration_hrs: 2.0, keywords: ["ex lap", "exploratory laparotomy", "trauma laparotomy"] },
  { cpt: "43644", name: "Laparoscopic Roux-en-Y gastric bypass", specialty: "General Surgery", work_rvu: 24.0, typical_duration_hrs: 2.5, keywords: ["gastric bypass", "bariatric", "roux-en-y"] },

  // --- Breast / endocrine ---------------------------------------------------
  { cpt: "19301", name: "Partial mastectomy (lumpectomy)", specialty: "Surgical Oncology", work_rvu: 10.3, typical_duration_hrs: 1.5, keywords: ["lumpectomy", "partial mastectomy", "breast"] },
  { cpt: "19307", name: "Modified radical mastectomy", specialty: "Surgical Oncology", work_rvu: 19.0, typical_duration_hrs: 2.5, keywords: ["mastectomy", "radical mastectomy"] },
  { cpt: "60240", name: "Total thyroidectomy", specialty: "General Surgery", work_rvu: 16.4, typical_duration_hrs: 2.5, keywords: ["thyroidectomy", "thyroid"] },

  // --- Cardiac --------------------------------------------------------------
  { cpt: "33533", name: "CABG, arterial, single graft", specialty: "Cardiothoracic Surgery", work_rvu: 33.8, typical_duration_hrs: 4.5, keywords: ["cabg", "bypass graft", "coronary artery bypass"] },
  { cpt: "33405", name: "Aortic valve replacement, prosthetic valve", specialty: "Cardiothoracic Surgery", work_rvu: 46.0, typical_duration_hrs: 5.5, keywords: ["avr", "aortic valve replacement", "aortic valve"] },
  { cpt: "33430", name: "Mitral valve replacement", specialty: "Cardiothoracic Surgery", work_rvu: 51.0, typical_duration_hrs: 6.0, keywords: ["mvr", "mitral valve replacement", "mitral"] },
  { cpt: "33863", name: "Ascending aorta + aortic root replacement", specialty: "Cardiothoracic Surgery", work_rvu: 65.0, typical_duration_hrs: 7.5, keywords: ["aortic root", "bentall", "ascending aorta"] },
  { cpt: "33208", name: "Permanent pacemaker insertion, dual chamber", specialty: "Cardiothoracic Surgery", work_rvu: 7.8, typical_duration_hrs: 1.0, keywords: ["pacemaker", "ppm"] },
  { cpt: "32663", name: "Thoracoscopic lobectomy (VATS)", specialty: "Cardiothoracic Surgery", work_rvu: 26.0, typical_duration_hrs: 3.5, keywords: ["vats", "lobectomy", "thoracoscopic"] },

  // --- Orthopaedics ---------------------------------------------------------
  { cpt: "27447", name: "Total knee arthroplasty", specialty: "Orthopaedic Surgery", work_rvu: 19.6, typical_duration_hrs: 2.0, keywords: ["tka", "total knee", "knee replacement"] },
  { cpt: "27130", name: "Total hip arthroplasty", specialty: "Orthopaedic Surgery", work_rvu: 20.7, typical_duration_hrs: 2.0, keywords: ["tha", "total hip", "hip replacement"] },
  { cpt: "27236", name: "ORIF femoral neck fracture", specialty: "Orthopaedic Surgery", work_rvu: 17.0, typical_duration_hrs: 2.0, keywords: ["orif", "hip fracture", "femoral neck"] },
  { cpt: "29881", name: "Knee arthroscopy with meniscectomy", specialty: "Orthopaedic Surgery", work_rvu: 8.8, typical_duration_hrs: 1.0, keywords: ["arthroscopy", "meniscectomy", "scope"] },

  // --- Spine / neuro --------------------------------------------------------
  { cpt: "22633", name: "Lumbar fusion, posterior interbody, single level", specialty: "Neurosurgery", work_rvu: 27.8, typical_duration_hrs: 4.0, keywords: ["lumbar fusion", "tlif", "plif", "fusion"] },
  { cpt: "63047", name: "Lumbar laminectomy / decompression, single level", specialty: "Neurosurgery", work_rvu: 15.4, typical_duration_hrs: 2.0, keywords: ["laminectomy", "decompression"] },
  { cpt: "61510", name: "Craniotomy for supratentorial brain tumor", specialty: "Neurosurgery", work_rvu: 38.0, typical_duration_hrs: 5.0, keywords: ["craniotomy", "brain tumor", "crani"] },
  { cpt: "61697", name: "Surgery of complex intracranial aneurysm", specialty: "Neurosurgery", work_rvu: 62.0, typical_duration_hrs: 7.0, keywords: ["aneurysm", "clipping", "intracranial aneurysm"] },

  // --- Vascular -------------------------------------------------------------
  { cpt: "35301", name: "Carotid endarterectomy", specialty: "Vascular Surgery", work_rvu: 20.3, typical_duration_hrs: 3.0, keywords: ["cea", "carotid", "endarterectomy"] },
  { cpt: "35656", name: "Femoral-popliteal bypass graft", specialty: "Vascular Surgery", work_rvu: 22.5, typical_duration_hrs: 3.5, keywords: ["fem-pop", "bypass", "femoral popliteal"] },

  // --- Urology --------------------------------------------------------------
  { cpt: "52601", name: "Transurethral resection of prostate (TURP)", specialty: "Urology", work_rvu: 15.3, typical_duration_hrs: 1.5, keywords: ["turp", "prostate resection"] },
  { cpt: "50590", name: "Extracorporeal shock wave lithotripsy", specialty: "Urology", work_rvu: 9.8, typical_duration_hrs: 1.0, keywords: ["lithotripsy", "eswl", "kidney stone"] },
  { cpt: "55866", name: "Laparoscopic radical prostatectomy", specialty: "Urology", work_rvu: 26.8, typical_duration_hrs: 3.5, keywords: ["prostatectomy", "radical prostatectomy", "rarp"] },

  // --- Obstetrics -----------------------------------------------------------
  { cpt: "59510", name: "Cesarean delivery (routine care package)", specialty: "Obstetrics", work_rvu: 24.0, typical_duration_hrs: 1.0, keywords: ["c-section", "cesarean", "csection"] },
];

/** Fast lookup by CPT code. */
const BY_CPT = new Map(PROCEDURES.map((p) => [p.cpt, p]));

export function getProcedureByCpt(cpt) {
  if (!cpt) return null;
  return BY_CPT.get(String(cpt).trim()) ?? null;
}

/**
 * Best-effort free-text lookup. Deliberately simple (normalized substring +
 * keyword match + token overlap) — this is the CHEAP path. When it fails, the
 * caller escalates to the LLM classifier in lib/prompts.js, which is the
 * interesting path and the one worth demoing.
 */
export function findProcedureByName(name) {
  if (!name) return null;
  const q = normalize(name);
  if (!q) return null;

  // 1. Exact-ish name match.
  for (const p of PROCEDURES) {
    if (normalize(p.name) === q) return { procedure: p, confidence: 1.0, method: "exact-name" };
  }

  // 2. Keyword containment — longest keyword wins so "open cholecystectomy"
  //    beats bare "cholecystectomy".
  let best = null;
  for (const p of PROCEDURES) {
    for (const kw of p.keywords) {
      const k = normalize(kw);
      if (k && q.includes(k)) {
        if (!best || k.length > best.matchLength) {
          best = { procedure: p, confidence: 0.8, method: "keyword", matchLength: k.length };
        }
      }
    }
  }
  if (best) {
    delete best.matchLength;
    return best;
  }

  // 3. Token overlap fallback.
  const qTokens = new Set(q.split(" ").filter((t) => t.length > 3));
  if (qTokens.size === 0) return null;
  let bestOverlap = null;
  for (const p of PROCEDURES) {
    const pTokens = new Set(normalize(`${p.name} ${p.keywords.join(" ")}`).split(" "));
    let overlap = 0;
    for (const t of qTokens) if (pTokens.has(t)) overlap += 1;
    const ratio = overlap / qTokens.size;
    if (ratio >= 0.5 && (!bestOverlap || ratio > bestOverlap.confidence)) {
      bestOverlap = { procedure: p, confidence: Math.min(0.7, ratio), method: "token-overlap" };
    }
  }
  return bestOverlap;
}

export function searchProcedures(query, limit = 20) {
  if (!query) return PROCEDURES.slice(0, limit);
  const q = normalize(query);
  return PROCEDURES.filter(
    (p) =>
      normalize(p.name).includes(q) ||
      p.cpt.includes(q) ||
      normalize(p.specialty).includes(q) ||
      p.keywords.some((k) => normalize(k).includes(q)),
  ).slice(0, limit);
}

export function listSpecialties() {
  return [...new Set(PROCEDURES.map((p) => p.specialty))].sort();
}

function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Free-text modifiers that meaningfully change difficulty but are not captured
 * by the CPT code itself. A redo sternotomy is a fundamentally harder operation
 * than a first-time one even though the billing code can be identical.
 */
export const COMPLEXITY_MODIFIERS = [
  { key: "redo", label: "Redo / revision", multiplier: 1.25, patterns: [/\bredo\b/i, /\brevision\b/i, /\bre-?operative\b/i] },
  { key: "emergent", label: "Emergent", multiplier: 1.2, patterns: [/\bemergen(t|cy)\b/i, /\bstat\b/i, /\bruptured?\b/i] },
  { key: "trauma", label: "Trauma activation", multiplier: 1.15, patterns: [/\btrauma\b/i, /\bgsw\b/i, /\bpenetrating\b/i] },
  { key: "pediatric", label: "Pediatric", multiplier: 1.1, patterns: [/\bpediatric\b/i, /\bpaediatric\b/i, /\bneonat/i, /\binfant\b/i] },
  { key: "robotic", label: "Robotic-assisted", multiplier: 1.05, patterns: [/\brobotic\b/i, /\bda vinci\b/i, /\brarp\b/i] },
];

export function detectModifiers(text) {
  if (!text) return [];
  return COMPLEXITY_MODIFIERS.filter((m) => m.patterns.some((re) => re.test(text))).map((m) => ({
    key: m.key,
    label: m.label,
    multiplier: m.multiplier,
  }));
}
