import { useState, useCallback, useEffect, useRef } from 'react';
import { getTankSensorData } from '../../api/routing';

/** Formats a Salesforce datetime string for display */
function fmtDate(val) {
  if (!val) return '—';
  try {
    return new Date(val).toLocaleString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return val; }
}

const statusStyle = {
  active: 'bg-green-100 text-green-700',
  critical: 'bg-red-100 text-red-700',
  warning: 'bg-yellow-100 text-yellow-700',
};

/** Single key-value row for the summary card */
function Field({ label, value, className = '' }) {
  return (
    <div className={className}>
      <span className="text-[10px] text-txt-secondary uppercase tracking-wide">{label}</span>
      <div className="text-xs font-medium text-txt mt-0.5">{value ?? '—'}</div>
    </div>
  );
}

/** Combined Tank + Sensor summary card, then Sensor Readings table */
export default function TankSensorData({ accountId, accountName }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [readingsOpen, setReadingsOpen] = useState(true);
  const prevIdRef = useRef(null);

  const fetchData = useCallback(async (id) => {
    setLoading(true);
    try {
      const res = await getTankSensorData(id);
      setData(res);
    } catch {
      setData({ tanks: [], sensors: [], readings: [] });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (accountId && accountId !== prevIdRef.current) {
      prevIdRef.current = accountId;
      setData(null);
      fetchData(accountId);
    }
  }, [accountId, fetchData]);

  const tanks = data?.tanks ?? [];
  const sensors = data?.sensors ?? [];
  const readings = data?.readings ?? [];
  const isEmpty = tanks.length === 0 && sensors.length === 0 && readings.length === 0;

  const tank = tanks[0];
  const sensor = sensors[0];

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-surface">
      <div className="px-3 py-2.5 text-[13px] font-medium text-txt">
        Tank & Sensor for <strong>{accountName ?? 'Account'}</strong>
      </div>

      {loading && <div className="p-3 text-xs text-txt-secondary animate-pulse border-t border-border">Loading…</div>}

      {!loading && data && isEmpty && (
        <div className="p-4 text-xs text-txt-secondary text-center border-t border-border">No tank or sensor data</div>
      )}

      {!loading && data && !isEmpty && (
        <>
          {/* Tank + Sensor combined card */}
          <div className="border-t border-border px-3 py-2.5 grid grid-cols-2 gap-x-6 gap-y-3">
            {/* Tank side */}
            <div>
              <div className="text-[11px] font-semibold text-txt-secondary mb-2 flex items-center gap-2">
                Tank
                {tank?.Status__c && (
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${statusStyle[tank.Status__c] ?? 'bg-gray-100 text-gray-600'}`}>
                    {tank.Status__c}
                  </span>
                )}
              </div>
              {tank ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <Field label="Name" value={tank.Name} />
                  <Field label="Max Volume" value={tank.MaxVolumeF__c != null ? `${tank.MaxVolumeF__c} GL` : null} />
                  <Field label="Last Volume" value={tank.LastVolume__c != null ? `${tank.LastVolume__c} GL` : null} />
                  <Field label="Last Record" value={fmtDate(tank.LastRecordOn__c)} />
                </div>
              ) : (
                <span className="text-xs text-txt-secondary">No tank</span>
              )}
            </div>

            {/* Sensor side */}
            <div>
              <div className="text-[11px] font-semibold text-txt-secondary mb-2">Sensor</div>
              {sensor ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <Field label="Name" value={sensor.Name} />
                  <Field label="Sensor Name" value={sensor.SensorName__c} />
                  <Field label="Temperature" value={sensor.LastRecordTemperatureF__c != null ? `${sensor.LastRecordTemperatureF__c} F` : null} />
                  <Field label="Last Record" value={fmtDate(sensor.LastRecordOn__c)} />
                </div>
              ) : (
                <span className="text-xs text-txt-secondary">No sensor</span>
              )}
            </div>
          </div>

          {/* Extra tanks/sensors if more than one */}
          {tanks.length > 1 && (
            <div className="border-t border-border px-3 py-1.5 text-[10px] text-txt-secondary">
              +{tanks.length - 1} more tank{tanks.length > 2 ? 's' : ''}
            </div>
          )}
          {sensors.length > 1 && (
            <div className="border-t border-border px-3 py-1.5 text-[10px] text-txt-secondary">
              +{sensors.length - 1} more sensor{sensors.length > 2 ? 's' : ''}
            </div>
          )}

          {/* Sensor Readings table */}
          {readings.length > 0 && (
            <div className="border-t border-border">
              <button
                className="flex items-center justify-between w-full px-3 py-2 text-[12px] font-semibold text-txt-secondary hover:bg-bg/60 transition"
                onClick={() => setReadingsOpen((v) => !v)}
              >
                <span>Sensor Readings ({readings.length})</span>
                <span className="text-[10px] transition-transform duration-200" style={{ transform: readingsOpen ? 'rotate(180deg)' : 'rotate(0)' }}>▲</span>
              </button>
              {readingsOpen && (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="bg-bg/50">
                        <th className="text-left px-2.5 py-2 font-semibold text-txt-secondary">Name</th>
                        <th className="text-left px-2.5 py-2 font-semibold text-txt-secondary">Sensor</th>
                        <th className="text-right px-2.5 py-2 font-semibold text-txt-secondary">Reading (F)</th>
                        <th className="text-right px-2.5 py-2 font-semibold text-txt-secondary">Temperature (F)</th>
                        <th className="text-left px-2.5 py-2 font-semibold text-txt-secondary">Record On</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {readings.map((r, i) => (
                        <tr key={r.Id ?? i} className="hover:bg-bg/40 transition-colors">
                          <td className="px-2.5 py-1.5 text-txt font-medium">{r.Name ?? '—'}</td>
                          <td className="px-2.5 py-1.5 text-txt">{r.Sensor__r?.Name ?? '—'}</td>
                          <td className="px-2.5 py-1.5 text-txt tabular-nums text-right">{r.ReadingF__c ?? '—'}</td>
                          <td className="px-2.5 py-1.5 text-txt tabular-nums text-right">{r.TemperatureF__c ?? '—'}</td>
                          <td className="px-2.5 py-1.5 text-txt tabular-nums">{fmtDate(r.RecordOn__c)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
