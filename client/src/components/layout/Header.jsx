import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import useStore from '../../store';
import Select from '../ui/Select';
import DatePicker from '../ui/DatePicker';
import Spinner from '../ui/Spinner';
import ErrorLogsPanel from '../ui/ErrorLogsPanel';
import ActionLogsPanel from '../ui/ActionLogsPanel';
import BellMenu from '../notifications/BellMenu';

/** Top toolbar — date, filters, actions, layout toggle, user menu */
export default function Header() {
  const serviceDate = useStore((st) => st.serviceDate);
  const setServiceDate = useStore((st) => st.setServiceDate);
  const recordType = useStore((st) => st.recordType);
  const setRecordType = useStore((st) => st.setRecordType);
  const recordTypes = useStore((st) => st.recordTypes);
  const serviceLocation = useStore((st) => st.serviceLocation);
  const setServiceLocation = useStore((st) => st.setServiceLocation);
  const serviceLocations = useStore((st) => st.serviceLocations);
  const routes = useStore((st) => st.routes);
  const routeId = useStore((st) => st.routeId);
  const selectRoute = useStore((st) => st.selectRoute);
  const refreshRoutes = useStore((st) => st.refreshRoutes);
  const isLoading = useStore((st) => st.isLoading);
  const panelMode = useStore((st) => st.panelMode);
  const setPanelMode = useStore((st) => st.setPanelMode);
  const openModal = useStore((st) => st.openModal);
  const driver = useStore((st) => st.driver);
  const [logsOpen, setLogsOpen] = useState(false);
  const toggleLogs = useCallback(() => { setLogsOpen((p) => !p); setActionLogsOpen(false); }, []);
  const closeLogs = useCallback(() => setLogsOpen(false), []);
  const [actionLogsOpen, setActionLogsOpen] = useState(false);
  const toggleActionLogs = useCallback(() => { setActionLogsOpen((p) => !p); setLogsOpen(false); }, []);
  const closeActionLogs = useCallback(() => setActionLogsOpen(false), []);
  const navigate = useNavigate();

  const modeIcons = { mapOnly: '🗺', split: '◫', listOnly: '☰' };

  const recordTypeOptions = recordTypes.map((rt) => ({ value: rt, label: rt }));

  const locationOptions = [
    { value: '', label: 'All Locations' },
    ...serviceLocations.map((loc) => ({ value: loc.Id, label: loc.Name })),
  ];

  const routeOptions = [
    { value: '', label: 'All Routes' },
    ...routes.map((r) => ({ value: r.Id ?? r.id, label: r.Name })),
  ];

  return (
    <header className="flex items-center gap-2 px-3 py-1.5 bg-surface border-b border-border shrink-0 h-12 z-10">
      {/* Filters */}
      <div className="flex items-center gap-1.5">
        <DatePicker value={serviceDate} onChange={setServiceDate} />
        <Select
          value={recordType}
          onChange={setRecordType}
          options={recordTypeOptions}
          placeholder="Record Type"
        />
        <Select
          value={serviceLocation || ''}
          onChange={(v) => setServiceLocation(v || null)}
          options={locationOptions}
          placeholder="All Locations"
          searchable
        />
        <Select
          value={routeId || ''}
          onChange={(v) => selectRoute(v || null)}
          options={routeOptions}
          placeholder="All Routes"
          searchable
          className="min-w-[140px]"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        <button
          className="h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-surface text-txt-secondary hover:bg-bg hover:text-txt transition disabled:opacity-50"
          title="Refresh"
          onClick={() => refreshRoutes()}
          disabled={isLoading}
        >
          {isLoading ? (
            <Spinner size="sm" />
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
            </svg>
          )}
        </button>
        <button
          className="h-8 px-3 rounded-lg bg-primary text-white text-[13px] font-medium hover:bg-primary-hover transition"
          onClick={() => openModal('isNew')}
        >
          + New
        </button>
        <button
          className="h-8 px-3 rounded-lg bg-ai text-white text-[13px] font-medium hover:bg-ai-hover transition flex items-center gap-1"
          onClick={() => openModal('isAIGenerate')}
        >
          <span className="text-xs">✦</span> AI Generate
        </button>
      </div>

      <div className="flex-1" />

      {/* Layout toggle */}
      <div className="inline-flex rounded-lg border border-border overflow-hidden">
        {Object.entries(modeIcons).map(([mode, icon]) => (
          <button
            key={mode}
            className={`h-8 px-2.5 text-xs border-none transition ${
              panelMode === mode
                ? 'bg-primary text-white'
                : 'bg-surface text-txt-secondary hover:bg-bg'
            }`}
            onClick={() => setPanelMode(mode)}
            title={mode}
          >
            {icon}
          </button>
        ))}
      </div>

      {/* Bell + Action logs + Error logs + User */}
      <div className="flex items-center gap-2 ml-2">
        <BellMenu />
        <button
          className={`h-8 w-8 flex items-center justify-center rounded-lg border transition ${actionLogsOpen ? 'border-ai bg-ai/10 text-ai' : 'border-border bg-surface text-txt-secondary hover:bg-bg hover:text-txt'}`}
          title="Action Logs"
          onClick={toggleActionLogs}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15a2.25 2.25 0 012.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
          </svg>
        </button>
        <button
          className={`h-8 w-8 flex items-center justify-center rounded-lg border transition ${logsOpen ? 'border-error bg-error-bg text-error' : 'border-border bg-surface text-txt-secondary hover:bg-bg hover:text-txt'}`}
          title="Error Logs"
          onClick={toggleLogs}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 12.75c1.148 0 2.278.08 3.383.237 1.037.146 1.866.966 1.866 2.013 0 3.728-2.35 6.75-5.25 6.75S6.75 18.728 6.75 15c0-1.046.83-1.867 1.866-2.013A24.204 24.204 0 0112 12.75zm0 0c2.883 0 5.647.508 8.207 1.44a23.91 23.91 0 01-1.152-6.135 23.881 23.881 0 01.117-2.68c.057-.58-.462-1.075-1.044-1.075H5.872c-.582 0-1.1.495-1.044 1.075.063.653.098 1.315.098 1.98 0 2.071-.376 4.053-1.065 5.89A23.97 23.97 0 0012 12.75zM9 6V4.5A2.25 2.25 0 0111.25 2.25h1.5A2.25 2.25 0 0115 4.5V6" />
          </svg>
        </button>
        {driver?.isAdmin && (
          <button
            className="h-8 w-8 flex items-center justify-center rounded-lg border border-border bg-surface text-txt-secondary hover:bg-bg hover:text-primary transition"
            title="Admin Panel"
            onClick={() => navigate('/admin')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        )}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-bg">
          <div className="w-6 h-6 rounded-full bg-primary-light text-primary text-[10px] font-bold flex items-center justify-center">
            {(driver?.name || 'U').charAt(0).toUpperCase()}
          </div>
          <span className="text-[13px] text-txt font-medium max-w-[100px] truncate">
            {driver?.name || 'User'}
          </span>
        </div>
      </div>
      <ActionLogsPanel open={actionLogsOpen} onClose={closeActionLogs} />
      <ErrorLogsPanel open={logsOpen} onClose={closeLogs} />
    </header>
  );
}
