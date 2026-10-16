import { Navigate, Route, BrowserRouter as Router, Routes } from "react-router";
import { ScrollToTop } from "./components/common/ScrollToTop";
import AppLayout from "./layout/AppLayout";
import MinimalLayout from "./layout/MinimalLayout";
import NotFound from "./pages/OtherPage/NotFound";
import AdminUsersPage from "./pages/admin/users";
import AuditPage from "./pages/audit";
import UsagePage from "./pages/usage";
import CoverageIndexPage from "./pages/coverage";
import MembersPage from "./pages/members";
import OverviewPage from "./pages/overview";
import ConnectionsPage from "./pages/connections";
import ProjectOverviewPage from "./pages/project";
import ProjectEnvironmentsPage from "./pages/project/environments";
import ProjectIntegrationsPage from "./pages/project/integrations";
import ProjectInventoryPage from "./pages/project/inventory";
import SbomPage from "./pages/project/sbom";
import AccessTokensPage from "./pages/account/tokens";
import OauthConsentPage from "./pages/oauth/consent";
import WorkspacePoliciesPage from "./pages/workspace/policies";
import { WorkspaceComponentsPage, WorkspaceCraPage, WorkspaceNotificationsPage, WorkspaceIssueTrackingPage, WorkspaceRemediationPage, WorkspaceRiskPage, WorkspaceVulnerabilitiesPage } from "./pages/workspace/security";
import ProjectNotificationsPage from "./pages/project/notifications";
import ProjectIssueTrackingPage from "./pages/project/issue-tracking";
import NotificationsPage from "./pages/notifications";
import ProjectPoliciesPage from "./pages/project/policies";
import ProjectRemediationPage from "./pages/project/remediation";
import ProjectCraPage from "./pages/project/cra";
import ProjectCoveragePage from "./pages/project/coverage";
import ProjectGraphPage from "./pages/project/graph";
import ProjectVulnerabilitiesPage from "./pages/project/vulnerabilities";
import ProjectLayout from "./pages/project/layout";
import ProjectMembersPage from "./pages/project/members";
import ProjectRepositoriesPage from "./pages/project/repositories";
import ProjectServicesPage from "./pages/project/services";
import JobPage from "./pages/project/job";
import ProjectJobsPage from "./pages/project/jobs";
import PipelinePage from "./pages/project/pipeline";
import ProjectPipelinesPage from "./pages/project/pipelines";
import ProjectRunnersPage from "./pages/project/runners";
import ProjectSettingsPage from "./pages/project/settings";
import RunnersPage from "./pages/runners";
import WorkspaceRunnersPage from "./pages/workspace/runners";
import WorkspaceOverviewPage from "./pages/workspace";
import WorkspaceIntegrationsPage from "./pages/workspace/integrations";
import WorkspaceLayout from "./pages/workspace/layout";
import WorkspaceMembersPage from "./pages/workspace/members";
import TeamLayout from "./pages/team/layout";
import TeamOverviewPage from "./pages/team";
import TeamMembersPage from "./pages/team/members";
import TeamSettingsPage from "./pages/team/settings";
import WorkspaceTeamsPage from "./pages/workspace/teams";
import InvitePage from "./pages/invite";
import WorkspaceProjectsPage from "./pages/workspace/projects";
import WorkspaceRepositoriesPage from "./pages/workspace/repositories";
import WorkspaceSettingsPage from "./pages/workspace/settings";
import ProjectsPage from "./pages/projects";
import RepositoriesPage from "./pages/repositories";
import { RequireAuth } from "./platform/auth/RequireAuth";

export default function App() {
  return (
    <Router>
      <ScrollToTop />
      <Routes>
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectLayout />}>
            <Route index element={<ProjectOverviewPage />} />
            <Route path="services" element={<ProjectServicesPage />} />
            <Route path="environments" element={<ProjectEnvironmentsPage />} />
            <Route path="repositories" element={<ProjectRepositoriesPage />} />
            <Route path="inventory" element={<ProjectInventoryPage />} />
            <Route path="sboms/:sbomId" element={<SbomPage />} />
            <Route path="vulnerabilities" element={<ProjectVulnerabilitiesPage />} />
            <Route path="policies" element={<ProjectPoliciesPage />} />
            <Route path="remediation" element={<ProjectRemediationPage />} />
            <Route path="cra" element={<ProjectCraPage />} />
            <Route path="coverage" element={<ProjectCoveragePage />} />
            <Route path="notifications" element={<ProjectNotificationsPage />} />
            <Route path="issue-tracking" element={<ProjectIssueTrackingPage />} />
            <Route path="graph" element={<ProjectGraphPage />} />
            <Route path="integrations" element={<ProjectIntegrationsPage />} />
            <Route path="members" element={<ProjectMembersPage />} />
            <Route path="pipelines" element={<ProjectPipelinesPage />} />
            <Route path="pipelines/:pipelineId" element={<PipelinePage />} />
            <Route path="jobs" element={<ProjectJobsPage />} />
            <Route path="jobs/:jobId" element={<JobPage />} />
            <Route path="runners" element={<ProjectRunnersPage />} />
            <Route path="settings" element={<ProjectSettingsPage />} />
          </Route>
          <Route path="/workspaces/:workspaceId" element={<WorkspaceLayout />}>
            <Route index element={<WorkspaceOverviewPage />} />
            <Route path="projects" element={<WorkspaceProjectsPage />} />
            <Route path="repositories" element={<WorkspaceRepositoriesPage />} />
            <Route path="integrations" element={<WorkspaceIntegrationsPage />} />
            <Route path="members" element={<WorkspaceMembersPage />} />
            <Route path="teams" element={<WorkspaceTeamsPage />} />
            <Route path="teams/:teamId" element={<TeamLayout />}>
              <Route index element={<TeamOverviewPage />} />
              <Route path="members" element={<TeamMembersPage />} />
              <Route path="settings" element={<TeamSettingsPage />} />
            </Route>
            <Route path="runners" element={<WorkspaceRunnersPage />} />
            <Route path="settings" element={<WorkspaceSettingsPage />} />
            <Route path="policies" element={<WorkspacePoliciesPage />} />
            <Route path="vulnerabilities" element={<WorkspaceVulnerabilitiesPage />} />
            <Route path="risk" element={<WorkspaceRiskPage />} />
            <Route path="components" element={<WorkspaceComponentsPage />} />
            <Route path="remediation" element={<WorkspaceRemediationPage />} />
            <Route path="cra" element={<WorkspaceCraPage />} />
            <Route path="notifications" element={<WorkspaceNotificationsPage />} />
            <Route path="issue-tracking" element={<WorkspaceIssueTrackingPage />} />
          </Route>
          <Route path="/repositories" element={<RepositoriesPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/integrations" element={<ConnectionsPage />} />
          <Route path="/runners" element={<RunnersPage />} />
          <Route path="/members" element={<MembersPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route path="/coverage" element={<CoverageIndexPage />} />
          <Route path="/admin/users" element={<AdminUsersPage />} />
          <Route path="/account/tokens" element={<AccessTokensPage />} />
        </Route>
        {/* OAuth consent: signed in, but outside the app chrome so nothing invites navigating away mid-flow */}
        <Route element={<RequireAuth><MinimalLayout /></RequireAuth>}>
          <Route path="/oauth/consent" element={<OauthConsentPage />} />
        </Route>
        {/* one-time setup link (invite / password reset): no sign-in — the link is the credential */}
        <Route element={<MinimalLayout />}>
          <Route path="/invite/:token" element={<InvitePage />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Router>
  );
}
