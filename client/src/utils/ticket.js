import { formatDateTime } from './date';

/** Ticket type label — Description holds Case.Type from the tickets API */
export function ticketTypeLabel(ticket) {
  return ticket?.ticketType || ticket?.Description || '';
}

/** Case record type (LRS, EZG, etc.) */
export function ticketRecordType(ticket) {
  return ticket?.caseRecordType || ticket?.CaseRecordType || ticket?.recordType || '';
}

/** Date/time the Case was opened */
export function ticketOpenedAt(ticket) {
  const raw = ticket?.ticketOpenedAt || ticket?.TicketOpenedAt || ticket?.createdDate;
  return raw ? formatDateTime(raw) : '';
}

/** Map latitude from tickets API (OpenTicketRow) or notification payload */
export function ticketLat(ticket) {
  return ticket?.MALatitude__c ?? ticket?.MALatitude ?? ticket?.accountLat;
}

/** Map longitude from tickets API (OpenTicketRow) or notification payload */
export function ticketLng(ticket) {
  return ticket?.MALongitude__c ?? ticket?.MALongitude ?? ticket?.accountLng;
}

export function ticketNotes(ticket) {
  return ticket?.Notes__c ?? ticket?.Notes ?? '';
}

/** Whether the ticket has valid map coordinates */
export function ticketHasCoords(ticket) {
  const lat = Number(ticketLat(ticket));
  const lng = Number(ticketLng(ticket));
  return !Number.isNaN(lat) && !Number.isNaN(lng) && !(lat === 0 && lng === 0)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}
