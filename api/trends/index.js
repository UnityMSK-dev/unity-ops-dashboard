const { getUserFromRequest } = require("../shared/auth");
const {
  resolveAccess,
  requireAccess,
  requireEntityViewAccess,
  safeErrorResponse
} = require("../shared/permissions");
const { getTableClient } = require("../shared/table");

const TABLE_NAME = "WeeklyRegionData";

function parseJsonSafely(value, fallback = {}) {
  if (!value) return fallback;

  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

function toNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toText(value, fallback = "") {
  if (value == null) return fallback;
  return String(value).trim();
}

function normalizeWeeklyValues(values = {}, record = null) {
  return {
    newPatients: toNumber(values.newPatients ?? values.npActual ?? record?.newPatients, 0),
    surgeries: toNumber(values.surgeries ?? values.surgeryActual ?? record?.surgeries, 0),
    established: toNumber(values.established ?? values.establishedActual ?? record?.established, 0),
    noShows: toNumber(values.noShows ?? record?.noShows, 0),
    cancelled: toNumber(values.cancelled ?? record?.cancelled, 0),
    totalCalls: toNumber(values.totalCalls ?? values.callVolume ?? record?.totalCalls ?? record?.callVolume, 0),
    abandonedCalls: toNumber(values.abandonedCalls ?? record?.abandonedCalls, 0),

    visitVolume: toNumber(values.visitVolume ?? values.totalVisits ?? record?.visitVolume, 0),
    callVolume: toNumber(values.callVolume ?? values.totalCalls ?? record?.callVolume ?? record?.totalCalls, 0),
    noShowRate: toNumber(values.noShowRate ?? record?.noShowRate, 0),
    cancellationRate: toNumber(values.cancellationRate ?? record?.cancellationRate, 0),
    abandonedCallRate: toNumber(
      values.abandonedCallRate ?? values.abandonmentRate ?? record?.abandonedCallRate,
      0
    ),

    ptScheduledVisits: toNumber(values.ptScheduledVisits ?? record?.ptScheduledVisits, 0),
    ptCancellations: toNumber(values.ptCancellations ?? record?.ptCancellations, 0),
    ptNoShows: toNumber(values.ptNoShows ?? record?.ptNoShows, 0),
    ptReschedules: toNumber(values.ptReschedules ?? record?.ptReschedules, 0),
    ptTotalUnitsBilled: toNumber(values.ptTotalUnitsBilled ?? record?.ptTotalUnitsBilled, 0),
    ptVisitsSeen: toNumber(values.ptVisitsSeen ?? record?.ptVisitsSeen, 0),
    ptWorkingDays: toNumber(values.ptWorkingDays ?? record?.ptWorkingDays, 5),
    ptUnitsPerVisit: toNumber(values.ptUnitsPerVisit ?? record?.ptUnitsPerVisit, 0),
    ptVisitsPerDay: toNumber(values.ptVisitsPerDay ?? record?.ptVisitsPerDay, 0),

    imaging: toNumber(values.imaging ?? record?.imaging, 0),
    reschedules: toNumber(values.reschedules ?? record?.reschedules, 0),
    // SpineOne PI fields — feed the Personal Injury trend chart on the
    // Trends view. Same pattern as imaging/reschedules: the data lives
    // in WeeklyRegionData (entered via the SpineOne PI section of the
    // weekly form), but if normalizeWeeklyValues drops them the
    // trends endpoint returns zeros and the chart looks blank even
    // though storage is fine.
    piNp: toNumber(values.piNp ?? record?.piNp, 0),
    piCashCollection: toNumber(values.piCashCollection ?? record?.piCashCollection, 0)
  };
}

function normalizeStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "approved") return "approved";
  if (s === "submitted") return "submitted";
  return "draft";
}

function mapRecord(record) {
  const values = normalizeWeeklyValues(parseJsonSafely(record.valuesJson, {}), record);

  return {
    entity: record.partitionKey || record.PartitionKey || record.entity,
    weekEnding: record.rowKey || record.RowKey || record.weekEnding,
    status: normalizeStatus(record.status),

    newPatients: values.newPatients,
    surgeries: values.surgeries,
    established: values.established,
    noShows: values.noShows,
    cancelled: values.cancelled,
    totalCalls: values.totalCalls,
    abandonedCalls: values.abandonedCalls,

    visitVolume: values.visitVolume,
    callVolume: values.callVolume,
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

    imaging: values.imaging,
    reschedules: values.reschedules,

    piNp: values.piNp,
    piCashCollection: values.piCashCollection,

    createdBy: toText(record.createdBy),
    createdAt: toText(record.createdAt),
    updatedBy: toText(record.updatedBy),
    updatedAt: toText(record.updatedAt),
    source: toText(record.source)
  };
}

module.exports = async function (context, req) {
  try {
    const user = getUserFromRequest(req);
    const access = resolveAccess(user);

    const authError = requireAccess(access);
    if (authError) return authError;

    const entity = String(req.query.entity || "").trim();
    const mode = String(req.query.mode || "recent").trim();
    const weeks = Math.max(1, Math.min(52, toNumber(req.query.weeks, 12)));
    const startDate = String(req.query.startDate || "").trim();
    const endDate = String(req.query.endDate || "").trim();

    if (!entity) {
      return {
        status: 400,
        body: {
          ok: false,
          error: "Missing entity"
        }
      };
    }

    const entityError = requireEntityViewAccess(access, entity);
    if (entityError) return entityError;

    const table = getTableClient(TABLE_NAME);
    const rows = await table.listByPartitionKey(entity);
    const mapped = rows
      .map(mapRecord)
      .sort((a, b) => String(b.weekEnding).localeCompare(String(a.weekEnding)));

    let items = mapped;

    if (mode === "dateRange") {
      items = mapped.filter((item) => {
        if (startDate && item.weekEnding < startDate) return false;
        if (endDate && item.weekEnding > endDate) return false;
        return true;
      });
    } else {
      items = mapped.slice(0, weeks);
    }

    return {
      status: 200,
      body: {
        ok: true,
        entity,
        mode,
        weeksRequested: mode === "recent" ? weeks : null,
        startDate: mode === "dateRange" ? startDate || null : null,
        endDate: mode === "dateRange" ? endDate || null : null,
        count: items.length,
        items
      }
    };
  } catch (error) {
    return safeErrorResponse(context, error, "Failed to load trends data");
  }
};
