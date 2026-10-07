import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import HostPool from './pages/HostPool';
import Sessions from './pages/Sessions';
import Images from './pages/Images';
import Scaling from './pages/Scaling';
import Cost from './pages/Cost';
import UsersAccess from './pages/UsersAccess';
import Profiles from './pages/Profiles';
import Monitoring from './pages/Monitoring';
import Governance from './pages/Governance';
import Audit from './pages/Audit';
import Settings from './pages/Settings';
import Incident from './pages/Incident';
import NotFound from './pages/NotFound';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="host-pools" element={<HostPool />} />
        <Route path="sessions" element={<Sessions />} />
        {/* AM-31 item 32a: tab selection lives in the URL so deep links + refresh keep the active tab — see Images.tsx's own doc comment. */}
        <Route path="images" element={<Images />} />
        <Route path="images/:tab" element={<Images />} />
        <Route path="scaling" element={<Scaling />} />
        <Route path="cost" element={<Cost />} />
        {/* AM-31 item 32b: the old joint Cost & Scaling page's route now redirects to its scaling half — see Scaling.tsx/Cost.tsx's own doc comments for the split. `replace` so the redirect doesn't leave an extra back-button entry. */}
        <Route path="cost-scaling" element={<Navigate to="/scaling" replace />} />
        <Route path="users-access" element={<UsersAccess />} />
        <Route path="profiles" element={<Profiles />} />
        <Route path="monitoring" element={<Monitoring />} />
        <Route path="governance" element={<Governance />} />
        {/* AM-32 (M8-W3): "/audit" is the clean route (nav item, command palette); "/audit-settings" is kept as a deep-link alias for whatever bookmarked the old placeholder's URL — both render the same Audit page. Order doesn't matter for react-router matching (these are sibling literal paths, not one a prefix of the other) — see Layout.tsx's NAV_ITEMS_BY_SPECIFICITY doc comment for the unrelated startsWith-matching concern that ordering comment was about. */}
        <Route path="audit" element={<Audit />} />
        <Route path="audit-settings" element={<Audit />} />
        <Route path="settings" element={<Settings />} />
        {/* AM-34 (M8-W5, D6): "Incident mode" — no permanent NavDrawer entry (see Layout.tsx's NAV_GROUPS doc comment); reached via the EstateStrip toggle, the `g n` chord, or the command palette (all three — see useKeyboardShortcuts.ts's NAV_SHORTCUTS — feed the same route). */}
        <Route path="incident" element={<Incident />} />
        {/* AM-15 (M7): catch-all — see NotFound.tsx's doc comment for the /hostpool white-page backlog item this closes. Must stay the LAST child route. */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
