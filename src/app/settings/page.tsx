import { pageDb } from "@/lib/db/request";
import * as React from "react";
import type { Metadata } from "next";
import { Settings as SettingsIcon } from "lucide-react";
import { PageTopbar } from "@/components/shell/page-topbar";
import { KeyValueList } from "@/components/ui/form";
import { aiRuntimeStatus } from "@/lib/ai/config";
import { db } from "@/lib/db";
import { currentUser, DEFAULT_USER } from "@/lib/current-user";
import { canManageWorkspace, workspaceView } from "@/modules/workspace/service";
import { TeamSettings } from "@/modules/workspace/components/team-settings";
import { IntegrityPanel } from "@/modules/settings/integrity-panel";
import { ReviewQueueSummary } from "@/modules/settings/review-queue-summary";
import { SettingsNav } from "@/modules/settings/settings-nav";
import { SettingsSection, SettingsBlock } from "@/modules/settings/settings-section";
import { ProviderTable } from "@/modules/settings/provider-table";
import { DataAutomationSection } from "@/modules/settings/data-automation";
import { AiSettings } from "@/modules/settings/ai-settings";
import { WorkspaceSettings } from "@/modules/settings/workspace-settings";
import { providersPayload } from "@/modules/settings/providers";
import { DemoDataSection } from "@/modules/settings/demo-data";
import { demoStatus } from "@/modules/demo";
import { getI18n } from "@/lib/i18n/server";
import { effectiveLanguagePreferences } from "@/lib/i18n/preferences";
import { currentPrincipal } from "@/lib/auth/context";
import { LanguageSettings } from "@/modules/settings/language-settings";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return { title: t("settings.title") };
}

/**
 * Settings: one page, left navigation. The workspace (firm profile, team) is
 * edited here; model and provider configuration is read from the environment
 * and reported by presence, never by value.
 */
export default async function SettingsPage() {
  await pageDb();
  const { t, number } = await getI18n();
  const ai = aiRuntimeStatus();
  const d = db();
  const me = currentUser((id) => d.people.get(id)?.name);
  const signedIn = me.id === DEFAULT_USER.id && me.name === DEFAULT_USER.name ? t("common.notSetUp") : me.name;
  const lang = effectiveLanguagePreferences();
  const principal = currentPrincipal();
  const workspace = workspaceView();
  const providers = providersPayload();
  const demo = demoStatus();
  const matters = d.matters.all().map((m) => ({ id: m.id, shortName: m.shortName }));
  const counts: { label: string; value: number }[] = [
    { label: t("settings.count.matters"), value: d.matters.count() }, { label: t("settings.count.people"), value: d.people.count() }, { label: t("settings.count.edocs"), value: d.edocs.count() },
    { label: t("settings.count.depositions"), value: d.depositions.count() }, { label: t("settings.count.workflows"), value: d.workflows.count() }, { label: t("settings.count.officeDocs"), value: d.officeDocs.count() },
    { label: t("settings.count.library"), value: d.library.count() }, { label: t("settings.count.tasks"), value: d.tasks.count() }, { label: t("settings.count.events"), value: d.events.count() },
  ];
  const primary = ai.roles.primary;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageTopbar icon={<SettingsIcon />} title={t("settings.title")} context={primary ? `${primary.provider} · ${primary.model}` : t("settings.noProvider")} />
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto grid max-w-6xl gap-x-10 gap-y-4 px-4 py-6 md:grid-cols-[168px_minmax(0,1fr)] md:px-6">
          <div className="md:sticky md:top-0 md:self-start">
            <SettingsNav />
          </div>
          <div className="min-w-0 space-y-10">
            <SettingsSection id="workspace" title={t("settings.group.workspace")} description={t("settings.desc.workspace")}>
              <WorkspaceSettings initial={workspace} />
            </SettingsSection>

            <SettingsSection id="language" title={t("settings.group.language")} description={t("settings.desc.language")}>
              <LanguageSettings initial={{ userAnswerLanguage: lang.userAnswerLanguage, answerLanguage: lang.answerLanguage, workspace: { defaultLocale: lang.workspace.defaultLocale, answerLanguage: lang.workspace.answerLanguage, timeZone: lang.workspace.timeZone }, canManageWorkspace: canManageWorkspace(principal) }} />
            </SettingsSection>

            <SettingsSection id="demo" title={t("settings.group.demo")} description={t("settings.desc.demo")}>
              <DemoDataSection initial={demo} />
            </SettingsSection>

            <SettingsSection id="team" title={t("settings.group.team")} bare>
              {/* Remounts (and refetches) when demo data is loaded or removed, so the demo team appears without a reload. */}
              <TeamSettings key={demo.loadedAt ?? "no-demo"} />
            </SettingsSection>

            <SettingsSection id="ai" title={t("settings.group.ai")} description={t("settings.desc.ai")}>
              <AiSettings status={ai} />
            </SettingsSection>

            <SettingsSection id="research" title={t("settings.group.research")} description={t("settings.desc.research")}>
              <ProviderTable initial={providers} />
            </SettingsSection>

            <SettingsSection id="data" title={t("settings.group.data")} description={t("settings.desc.data")}>
              <DataAutomationSection background={providers.background} dataDir={providers.dataDir} corpusFolders={providers.providers.find((p) => p.id === "local-corpus")?.facts?.folders as number ?? 0} />
            </SettingsSection>

            <SettingsSection id="integrity" title={t("settings.group.integrity")} description={t("settings.desc.integrity", { dir: providers.dataDir })}>
              <div className="space-y-3">
                <SettingsBlock title={t("settings.records")}>
                  <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-3">
                    {counts.map((c) => (
                      <div key={c.label} className="flex h-7 items-center justify-between border-b border-line-quiet text-[12px]"><span className="text-muted-foreground">{c.label}</span><span className="tabular">{number(c.value)}</span></div>
                    ))}
                  </div>
                </SettingsBlock>
                <ReviewQueueSummary matters={matters} />
                <IntegrityPanel />
              </div>
            </SettingsSection>

            <SettingsSection id="about" title={t("settings.group.about")}>
              <KeyValueList dense columns={2} labelWidth={120} items={[
                { label: t("settings.about.application"), value: process.env.NEXT_PUBLIC_APP_NAME ?? t("brand.name") },
                { label: t("settings.about.firm"), value: workspace.configured ? workspace.firmName : t("common.notSetUp"), muted: !workspace.configured },
                { label: t("settings.about.signedInAs"), value: signedIn },
                { label: t("settings.about.region"), value: t("settings.lang.timeZoneValue") },
                { label: t("settings.about.runtime"), value: `Next.js 15 · React 19 · Node ${process.versions.node}`, mono: true },
                { label: t("settings.about.environment"), value: process.env.NODE_ENV, mono: true },
                { label: t("settings.about.keyboard"), value: t("settings.about.keyboardValue") },
              ]} />
            </SettingsSection>
          </div>
        </div>
      </div>
    </div>
  );
}
