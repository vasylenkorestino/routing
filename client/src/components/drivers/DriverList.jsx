import { useState, useCallback } from 'react';
import useStore from '../../store';
import { getRouteByDriver } from '../../api/routing';
import DataTable from '../shared/DataTable';

const COLUMNS = [{ key: 'Name', label: 'Name' }];

/** Driver list table — click to load driver routes */
export default function DriverList() {
  const drivers = useStore((s) => s.drivers);
  const [selectedId, setSelectedId] = useState(null);
  const [stops, setStops] = useState([]);

  const handleClick = useCallback(async (driver) => {
    setSelectedId(driver.Id);
    try {
      const data = await getRouteByDriver({ driverId: driver.Id });
      setStops(data.points ?? data.stops ?? []);
    } catch { setStops([]); }
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <DataTable columns={COLUMNS} data={drivers} onRowClick={handleClick} />
      {selectedId && stops.length > 0 && (
        <div>
          <div className="font-medium text-sm text-txt mb-1">Stops</div>
          {stops.map((pt, i) => (
            <div key={pt.Id ?? i} className="text-xs py-0.5 text-txt-secondary">
              {i + 1}. {pt.Address ?? pt.Name ?? '—'}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
