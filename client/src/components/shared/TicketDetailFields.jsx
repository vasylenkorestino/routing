import { ticketOpenedAt, ticketRecordType, ticketTypeLabel } from '../../utils/ticket';

/** Ticket Type, Date/Time Opened, and Record Type — map popup (inline) or panel (Tailwind) */
export default function TicketDetailFields({ ticket, variant = 'panel' }) {
  const type = ticketTypeLabel(ticket);
  const opened = ticketOpenedAt(ticket);
  const recordType = ticketRecordType(ticket);
  if (!type && !opened && !recordType) return null;

  if (variant === 'popup') {
    return (
      <div style={{ marginTop: 4 }}>
        {type && (
          <div style={{ fontSize: 12, marginBottom: 2 }}>
            <strong>Ticket Type:</strong> {type}
          </div>
        )}
        {opened && (
          <div style={{ fontSize: 12, marginBottom: 2 }}>
            <strong>Date/Time Opened:</strong> {opened}
          </div>
        )}
        {recordType && (
          <div style={{ fontSize: 12, marginBottom: 2 }}>
            <strong>Record Type:</strong> {recordType}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-1 space-y-0.5">
      {type && (
        <div className="text-[11px] text-txt-secondary">
          <span className="font-semibold text-txt">Ticket Type:</span> {type}
        </div>
      )}
      {opened && (
        <div className="text-[11px] text-txt-secondary">
          <span className="font-semibold text-txt">Date/Time Opened:</span> {opened}
        </div>
      )}
      {recordType && (
        <div className="text-[11px] text-txt-secondary">
          <span className="font-semibold text-txt">Record Type:</span> {recordType}
        </div>
      )}
    </div>
  );
}
