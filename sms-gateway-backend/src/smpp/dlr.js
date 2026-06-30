export function parseDlrText(text) {
  const s = String(text || "");

  // Common format: "id:xxxx sub:001 dlvrd:001 submit date:... done date:... stat:DELIVRD err:000 text:..."
  const idMatch = s.match(/\bid:([^\s]+)/i);
  const statMatch = s.match(/\bstat:([^\s]+)/i);

  const smppMessageId = idMatch?.[1] || null;
  const stat = statMatch?.[1] || null;

  const mapped =
    stat?.toUpperCase() === "DELIVRD" ? "DELIVERED"
    : stat?.toUpperCase() === "UNDELIV" ? "UNDELIVERED"
    : stat?.toUpperCase() === "EXPIRED" ? "EXPIRED"
    : stat?.toUpperCase() === "REJECTD" ? "REJECTED"
    : stat ? "UNKNOWN"
    : null;

  return { smppMessageId, rawStat: stat, status: mapped };
}
