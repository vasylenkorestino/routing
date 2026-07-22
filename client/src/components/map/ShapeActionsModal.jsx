import { createPortal } from 'react-dom';
import useStore from '../../store';

/** Modal shown when a shape polygon is clicked — Edit / Show Accounts. */
export default function ShapeActionsModal() {
  const shape = useStore((s) => s.shapeActionsTarget);
  const setShapeActionsTarget = useStore((s) => s.setShapeActionsTarget);
  const setEditingShapeId = useStore((s) => s.setEditingShapeId);
  const shapeAccountLayers = useStore((s) => s.shapeAccountLayers);
  const setShapeAccountLayer = useStore((s) => s.setShapeAccountLayer);
  const setLayerVisible = useStore((s) => s.setLayerVisible);

  if (!shape) return null;

  const accountsVisible = !!shapeAccountLayers[shape.Id]?.visible;

  /** Starts boundary/property edit for the clicked shape. */
  const handleEdit = () => {
    setShapeActionsTarget(null);
    setLayerVisible('shapes', true);
    setEditingShapeId(shape.Id);
  };

  /** Toggles account markers for this shape on the map. */
  const handleToggleAccounts = () => {
    setShapeAccountLayer(shape.Id, { visible: !accountsVisible, shape });
    setShapeActionsTarget(null);
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShapeActionsTarget(null)} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h3 className="text-base font-semibold text-gray-900 truncate pr-2">{shape.Name || 'Shape'}</h3>
          <button
            type="button"
            className="w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:bg-gray-100"
            onClick={() => setShapeActionsTarget(null)}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="flex flex-wrap gap-2 px-5 pb-5 pt-1">
          <button
            type="button"
            className="px-3 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition"
            onClick={handleEdit}
          >
            Edit
          </button>
          <button
            type="button"
            className={`px-3 py-2 text-sm font-medium rounded-lg transition ${
              accountsVisible
                ? 'bg-gray-100 text-gray-800 hover:bg-gray-200'
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
            }`}
            onClick={handleToggleAccounts}
          >
            {accountsVisible ? 'Hide Accounts' : 'Show Accounts'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
