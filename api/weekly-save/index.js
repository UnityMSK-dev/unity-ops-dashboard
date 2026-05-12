const { getUserFromRequest } = require("../shared/auth");
const {
  resolveAccess,
  requireAccess,
  requireEntityAccess,
  safeErrorResponse,
  toSafeNumber
} = require("../shared/permissions");
const { getTableClient } = require("../shared/table");

const TABLE_NAME = "WeeklyRegionData";

// Negative values and NaN are always invalid for these operational counters.
const toNumber = (value, fallback = 0) => toSafeNumber(value, fallback);

function toText(value, fallback = "") {
  if (value == null) return fallback;
  return String(value).trim();
}

function calculateDerived(values = {}) {
  const newPatients = toNumber(values.newPatients, 0);
  const surgeries = toNumber(values.surgeries, 0);
  const established = toNumber(values.established, 0);
  const noShows = toNumber(values.noShows, 0);
  const cancelled = toNumber(values.cancelled, 0);
  const totalCalls = toNumber(values.totalCalls ?? values.callVolume, 0);
  const abandonedCalls = toNumber(values.abandonedCalls, 0);

  const visitVolume = newPatients + surgeries + established;
  const callVolume = totalCalls;
  const scheduledAppointments = visitVolume + noShows + cancelled;

  const noShowRate =
    scheduledAppointments > 0 ? (noShows / scheduledAppointments) * 100 : 0;

  const cancellationRate =
    scheduledAppointments > 0 ? (cancelled / scheduledAppointments) * 100 : 0;

  const abandonedCallRate =
    totalCalls > 0 ? (abandonedCalls / totalCalls) * 100 : 0;

  const ptScheduledVisits = toNumber(values.ptScheduledVisits, 0);
  const ptCancellations = toNumber(values.ptCancellations, 0);
  const ptNoShows = toNumber(values.ptNoShows, 0);
  const ptReschedules = toNumber(values.ptReschedules, 0);
  const ptTotalUnitsBilled = toNumber(values.ptTotalUnitsBilled, 0);
  const ptVisitsSeen = toNumber(values.ptVisitsSeen, 0);
  const ptWorkingDays = Math.max(1, toNumber(values.ptWorkingDays, 5));

  const ptUnitsPerVisit =
    ptVisitsSeen > 0 ? ptTotalUnitsBilled / ptVisitsSeen : 0;

  const ptVisitsPerDay =
    ptWorkingDays > 0 ? ptVisitsSeen / ptWorkingDays : 0;

  const ptoDays = toNumber(values.ptoDays, 0);
  const cashCollected = toNumber(values.cashCollected, 0);
  const piNp = toNumber(values.piNp, 0);
  const piCashCollection = toNumber(values.piCashCollection, 0);
  // Imaging is SpineOne-only; reschedules is non-LAOSS. Both come from the
  // ortho input section. Historically these were missing from this function,
  // which silently dropped any value the user typed (regression of an earlier
  // bug — the frontend registry had them, but the API never mirrored them).
  const imaging = toNumber(values.imaging, 0);
  const reschedules = toNumber(values.reschedules, 0);
  const operationsNarrative = toText(values.operationsNarrative, "");

  return {
    newPatients,
    surgeries,
    established,
    noShows,
    cancelled,
    totalCalls,
    abandonedCalls,
    visitVolume,
    callVolume,
    noShowRate: Number(noShowRate.toFixed(2)),
    cancellationRate: Number(cancellationRate.toFixed(2)),
    abandonedCallRate: Number(abandonedCallRate.toFixed(2)),

    ptScheduledVisits,
    ptCancellations,
    ptNoShows,
    ptReschedules,
    ptTotalUnitsBilled,
    ptVisitsSeen,
    ptWorkingDays,
    ptUnitsPerVisit: Number(ptUnitsPerVisit.toFixed(2)),
    ptVisitsPerDay: Number(ptVisitsPerDay.toFixed(2)),

    ptoDays,
    cashCollected,
    piNp,
    piCashCollection,
    imaging,
    reschedules,
    operationsNarrative
  };
}

module.exports = async function (context, req) {
  try {
    const user = getUserFromRequest(req);
    const access = resolveAccess(user);

    const authError = requireAccess(access);
    if (authError) return authError;

    const entity = String(req.body?.entity || "").trim();
    const weekEnding = String(req.body?.weekEnding || "").trim();
    const input =
      req.body?.data && typeof req.body.data === "object"
        ? req.body.data
        : req.body?.values && typeof req.body.values === "object"
          ? req.body.values
          : {};
    // Save scope: "ortho", "pt", or "all" (default). When the form is in
    // PT mode the client only knows about PT fields — ortho fields in
    // the payload may be stale snapshots from when the form first
    // loaded. If we trust those naively, a PT save can clobber a
    // concurrent ortho save (Annette flagged Tim wiping NES ortho data
    // 2026-05-05). Server-side scope-aware merge fixes the race: we
    // re-read the live record and overlay only the in-scope fields
    // from the request.
    const mode = String(req.body?.mode || "all").toLowerCase();
    const SCOPE = mode === "pt" ? "pt" : mode === "ortho" ? "ortho" : "all";

    if (!entity || !weekEnding) {
      return {
        status: 400,
        body: {
          ok: false,
          error: "Missing entity or weekEnding"
        }
      };
    }

    const entityError = requireEntityAccess(access, entity);
    if (entityError) return entityError;

    const table = getTableClient(TABLE_NAME);

    let existing = null;
    try {
      existing = await table.getEntity(entity, weekEnding);
    } catch (err) {
      if (err.statusCode !== 404) {
        throw err;
      }
    }

    // Merge against the live record so a PT save can never clobber
    // ortho values (and vice versa). Read the canonical snapshot from
    // either valuesJson (preferred — full shape) or the explicit
    // columns on the row.
    const ORTHO_FIELDS = [
      "newPatients", "surgeries", "established", "noShows", "cancelled",
      "totalCalls", "abandonedCalls", "cashCollected",
      "piNp", "piCashCollection", "imaging", "reschedules"
    ];
    const PT_FIELDS = [
      "ptScheduledVisits", "ptCancellations", "ptNoShows", "ptReschedules",
      "ptTotalUnitsBilled", "ptVisitsSeen", "ptWorkingDays"
    ];
    const SHARED_FIELDS = ["ptoDays", "operationsNarrative"];

    let existingValues = {};
    if (existing) {
      try {
        existingValues = existing.valuesJson
          ? JSON.parse(String(existing.valuesJson))
          : { ...existing };
      } catch (_) {
        existingValues = { ...existing };
      }
    }

    const inScope = (field) => {
      if (SCOPE === "all") return true;
      if (SHARED_FIELDS.includes(field)) return true;
      if (SCOPE === "pt") return PT_FIELDS.includes(field);
      if (SCOPE === "ortho") return ORTHO_FIELDS.includes(field);
      return false;
    };

    // Start with the live record, overlay only the in-scope fields from
    // the request. Out-of-scope fields keep their existing values
    // regardless of what the client sent.
    const mergedInput = { ...existingValues };
    [...ORTHO_FIELDS, ...PT_FIELDS, ...SHARED_FIELDS].forEach((field) => {
      if (inScope(field) && input[field] !== undefined) {
        mergedInput[field] = input[field];
      }
    });

    const values = calculateDerived(mergedInput);

    await table.upsertEntity({
      partitionKey: entity,
      rowKey: weekEnding,
      entity,
      weekEnding,
      status: "saved",
      valuesJson: JSON.stringify(values),

      visitVolume: values.visitVolume,
      callVolume: values.callVolume,
      newPatients: values.newPatients,
      surgeries: values.surgeries,
      established: values.established,
      noShows: values.noShows,
      cancelled: values.cancelled,
      totalCalls: values.totalCalls,
      abandonedCalls: values.abandonedCalls,
      noShowRate: values.noShowRate,
      cancellationRate: values.cancellationRate,
      abandonedCallRate: values.abandonedCallRate,

      ptScheduledVisits: values.ptScheduledVisits,
      ptCancellations: values.ptCancellations,
      ptNoShows: values.ptNoShows,
      ptReschedules: values.ptReschedules,
      ptTotalUnitsBilled: values.ptTotalUnitsBilled,
      ptVisitsSeen: values.ptVisitsSeen,
      ptWorkingDays: values.ptWorkingDays,
      ptUnitsPerVisit: values.ptUnitsPerVisit,
      ptVisitsPerDay: values.ptVisitsPerDay,

      ptoDays: values.ptoDays,
      cashCollected: values.cashCollected,
      piNp: values.piNp,
      piCashCollection: values.piCashCollection,
      imaging: values.imaging,
      reschedules: values.reschedules,
      operationsNarrative: values.operationsNarrative,

      source: existing?.source || "app",
      createdBy: existing?.createdBy || access.email || user?.userDetails || null,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedBy: access.email || user?.userDetails || null,
      updatedAt: new Date().toISOString()
    });

    return {
      status: 200,
      body: {
        ok: true,
        message: "Saved successfully",
        status: "saved",
        entity,
        weekEnding,
        values
      }
    };
  } catch (error) {
    return safeErrorResponse(context, error, "Failed to save weekly region data.");
  }
};