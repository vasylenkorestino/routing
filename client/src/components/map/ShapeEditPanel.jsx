import { useCallback, useEffect, useState } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/** Org Shape__c RecordType Ids (same as MapApplication.page). */
const SHAPE_RECORD_TYPES = [
  { id: '0126T000001QGloQAG', name: 'EZG' },
  { id: '012PM000001r1QPYAY', name: 'ENJ' },
];

/** Serializes a Google Maps polygon path to Shape__c Coordinates__c JSON. */
export function coordinatesFromPolygon(polygon) {
  if (!polygon) return null;
  const path = polygon.getPath();
  const coords = [];
  for (let i = 0; i < path.getLength(); i += 1) {
    const xy = path.getAt(i);
    coords.push([xy.lng(), xy.lat()]);
  }
  return JSON.stringify([coords]);
}

/**
 * Floating edit form while a shape polygon is editable on the map.
 * Saves name, record type, color, service location, and boundary.
 */
export default function ShapeEditPanel({ shapeLayerRef }) {
  const editingShapeId = useStore((s) => s.editingShapeId);
  const setEditingShapeId = useStore((s) => s.setEditingShapeId);
  const shapes = useStore((s) => s.layers.shapes.data);
  const setLayerData = useStore((s) => s.setLayerData);
  const recordType = useStore((s) => s.recordType);

  const shape = shapes.find((s) => s.Id === editingShapeId) || null;
  const getPolygon = (id) => shapeLayerRef?.current?.getPolygon?.(id);

  const [name, setName] = useState('');
  const [recordTypeId, setRecordTypeId] = useState(SHAPE_RECORD_TYPES[0].id);
  const [color, setColor] = useState('#2563eb');
  const [serviceLocationId, setServiceLocationId] = useState('');
  const [locations, setLocations] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!shape) return;
    setName(shape.Name || '');
    setRecordTypeId(shape.RecordTypeId || SHAPE_RECORD_TYPES[0].id);
    setColor(shape.Color__c || '#2563eb');
    setServiceLocationId(shape.Service_Location__c || '');
  }, [shape]);

  /** Loads Service Location options for the selected record type. */
  useEffect(() => {
    if (!editingShapeId) return;
    const rtName = SHAPE_RECORD_TYPES.find((r) => r.id === recordTypeId)?.name || recordType;
    routingApi.getServiceLocations({ recordTypeName: rtName }).then((data) => {
      const list = Array.isArray(data) ? data : data.locations ?? data.serviceLocations ?? [];
      setLocations(list);
    }).catch(() => setLocations([]));
  }, [editingShapeId, recordTypeId, recordType]);

  /** Cancels edit and restores the original polygon path. */
  const handleCancel = useCallback(() => {
    const poly = getPolygon(editingShapeId);
    if (poly && shape?.Coordinates__c) {
      try {
        const coords = typeof shape.Coordinates__c === 'string'
          ? JSON.parse(shape.Coordinates__c)
          : shape.Coordinates__c;
        const path = (coords?.[0] || []).map(([lng, lat]) => ({ lat, lng }));
        poly.setPath(path);
      } catch {
        /* keep current path */
      }
    }
    setEditingShapeId(null);
  }, [editingShapeId, shape, setEditingShapeId, shapeLayerRef]);

  /** Persists shape properties + edited boundary. */
  const handleSave = useCallback(async () => {
    if (!shape) return;
    if (!serviceLocationId) {
      toast.error('Please select a Service Location.');
      return;
    }
    const poly = getPolygon(editingShapeId);
    const coordinates = coordinatesFromPolygon(poly) || shape.Coordinates__c;
    setSaving(true);
    try {
      await routingApi.updateShape({
        shape: {
          Id: shape.Id,
          Name: name,
          RecordTypeId: recordTypeId,
          Color__c: color,
          Coordinates__c: coordinates,
          Service_Location__c: serviceLocationId,
        },
      });
      const data = await routingApi.getShapes({ recordTypeName: recordType });
      const next = Array.isArray(data) ? data : data.shapes ?? [];
      setLayerData('shapes', next);
      setEditingShapeId(null);
      toast.success('Shape updated successfully');
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [
    shape, serviceLocationId, editingShapeId, name, recordTypeId, color,
    recordType, setLayerData, setEditingShapeId, shapeLayerRef,
  ]);

  if (!shape) return null;

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 w-[min(420px,calc(100%-2rem))] bg-surface border border-border rounded-xl shadow-xl p-3">
      <div className="text-[12px] font-semibold text-txt mb-2">Edit shape — drag vertices on the map</div>
      <div className="grid grid-cols-2 gap-2">
        <input
          className="col-span-2 px-2 py-1.5 text-sm border border-border rounded-md bg-bg"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
        />
        <select
          className="px-2 py-1.5 text-sm border border-border rounded-md bg-bg"
          value={recordTypeId}
          onChange={(e) => setRecordTypeId(e.target.value)}
        >
          {SHAPE_RECORD_TYPES.map((rt) => (
            <option key={rt.id} value={rt.id}>{rt.name}</option>
          ))}
        </select>
        <input
          type="color"
          className="h-9 w-full border border-border rounded-md bg-bg cursor-pointer"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          title="Color"
        />
        <select
          className="col-span-2 px-2 py-1.5 text-sm border border-border rounded-md bg-bg"
          value={serviceLocationId}
          onChange={(e) => setServiceLocationId(e.target.value)}
        >
          <option value="" disabled>Select Service Location</option>
          {locations.map((sl) => (
            <option key={sl.Id} value={sl.Id}>{sl.Name}</option>
          ))}
        </select>
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <button
          type="button"
          className="px-3 py-1.5 text-sm font-medium rounded-lg bg-bg text-txt border border-border hover:bg-border/30"
          onClick={handleCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="px-3 py-1.5 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary/90 disabled:opacity-50"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
