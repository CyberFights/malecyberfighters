import { useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Bell,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Code2,
  GitBranch,
  GitPullRequest,
  Github,
  CircleAlert,
  ShieldCheck,
  Star,
  Users,
  XStack,
  YStack,
  ScrollView,
  Card,
  Button,
  H1,
  H3,
  Paragraph,
  SizableText,
  Separator,
} from '@blinkdotnew/mobile-ui';

type Repo = {
  name: string;
  description: string;
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  language: string;
  updated: string;
  visibility: string;
};

type Issue = { title: string; number: number; labels: string[]; age: string };

type RepoPayload = {
  repo: Repo;
  issues: Issue[];
};

const FALLBACK: RepoPayload = {
  repo: {
    name: 'malecyberfighters',
    description: 'CyberFighters project hub for code, collaboration, and open-source experiments.',
    stars: 128,
    forks: 24,
    watchers: 19,
    openIssues: 7,
    language: 'TypeScript',
    updated: 'Today, 09:42',
    visibility: 'Public',
  },
  issues: [
    { title: 'Polish the mobile command center experience', number: 42, labels: ['enhancement'], age: '2h ago' },
    { title: 'Document local development setup', number: 39, labels: ['documentation'], age: 'yesterday' },
    { title: 'Add release checklist for contributors', number: 36, labels: ['process'], age: '3d ago' },
  ],
};

async function getRepository(): Promise<RepoPayload> {
  const headers = { Accept: 'application/vnd.github+json' };
  const [repoResponse, issueResponse] = await Promise.all([
    fetch('https://api.github.com/repos/malecyberfighters/malecyberfighters', { headers }),
    fetch('https://api.github.com/repos/malecyberfighters/malecyberfighters/issues?state=open&per_page=3', { headers }),
  ]);

  if (!repoResponse.ok) throw new Error('GitHub data is temporarily unavailable');
  const repo = await repoResponse.json();
  const issues = issueResponse.ok ? await issueResponse.json() : [];
  return {
    repo: {
      name: repo.name,
      description: repo.description || FALLBACK.repo.description,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      watchers: repo.subscribers_count || repo.watchers_count,
      openIssues: repo.open_issues_count,
      language: repo.language || 'Mixed stack',
      updated: new Date(repo.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      visibility: repo.private ? 'Private' : 'Public',
    },
    issues: issues.filter((item: { pull_request?: unknown }) => !item.pull_request).map((item: { title: string; number: number; labels: { name: string }[] }) => ({
      title: item.title,
      number: item.number,
      labels: item.labels.slice(0, 1).map((label) => label.name),
      age: 'open now',
    })),
  };
}

function StatCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <Card bordered backgroundColor="#111D35" borderColor="#263A5D" padding="$3" flex={1} minWidth={140}>
      <XStack alignItems="center" gap="$2">
        {icon}
        <SizableText color="#89A2C7" size="$2">{label}</SizableText>
      </XStack>
      <SizableText color="#F2F7FF" size="$7" fontWeight="800" marginTop="$2">{value}</SizableText>
    </Card>
  );
}

export default function Home() {
  const [tab, setTab] = useState<'overview' | 'issues'>('overview');
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['github-repository'],
    queryFn: getRepository,
    placeholderData: FALLBACK,
  });
  const content = data || FALLBACK;
  const repo = content.repo;

  const feedback = () => {
    if (Platform.OS !== 'web') {
      // Native haptics can be added without affecting the web preview.
    }
  };

  return (
    <YStack flex={1} backgroundColor="#08111F">
      <ScrollView contentContainerStyle={{ paddingBottom: 36 }} showsVerticalScrollIndicator={false}>
        <YStack paddingHorizontal="$4" paddingTop="$6" gap="$5" maxWidth={720} width="100%" alignSelf="center">
          <XStack justifyContent="space-between" alignItems="center">
            <XStack alignItems="center" gap="$3">
              <YStack width={42} height={42} borderRadius="$4" backgroundColor="#12375A" alignItems="center" justifyContent="center">
                <Github size={24} color="#63D9FF" />
              </YStack>
              <YStack>
                <SizableText color="#7693BB" size="$2" fontWeight="700" letterSpacing={1.5}>CYBERFIGHTERS</SizableText>
                <SizableText color="#F2F7FF" size="$5" fontWeight="800">Mobile Hub</SizableText>
              </YStack>
            </XStack>
            <Button circular size="$4" chromeless backgroundColor="#111D35" onPress={feedback} accessibilityLabel="Notifications">
              <Bell size={20} color="#9AB4D8" />
            </Button>
          </XStack>

          <YStack gap="$2">
            <XStack alignItems="center" gap="$2">
              <SizableText color="#63D9FF" size="$3" fontWeight="700">REPOSITORY OVERVIEW</SizableText>
              <YStack backgroundColor="#143A38" borderRadius="$2" paddingHorizontal="$2" paddingVertical="$1"><SizableText color="#6CE7C2" size="$2" fontWeight="700">{repo.visibility}</SizableText></YStack>
            </XStack>
            <H1 color="#F2F7FF" fontSize={32} lineHeight={38} fontWeight="800">{repo.name}</H1>
            <Paragraph color="#9AB4D8" size="$4" lineHeight={23}>{repo.description}</Paragraph>
          </YStack>

          <Card bordered backgroundColor="#0D1A2E" borderColor="#1B3556" padding="$4" gap="$4">
            <XStack justifyContent="space-between" alignItems="center">
              <XStack alignItems="center" gap="$2">
                <Activity size={18} color="#63D9FF" />
                <SizableText color="#F2F7FF" fontWeight="700">Workspace pulse</SizableText>
              </XStack>
              <XStack alignItems="center" gap="$2">
                <YStack width={7} height={7} borderRadius={7} backgroundColor={isError ? '#F4B860' : '#63E6BE'} />
                <SizableText color="#89A2C7" size="$2">{isLoading ? 'Syncing' : isError ? 'Cached' : 'Live'}</SizableText>
              </XStack>
            </XStack>
            <XStack gap="$3">
              <YStack flex={1} height={64} backgroundColor="#102844" borderRadius="$3" padding="$3" justifyContent="space-between">
                <SizableText color="#7E9BC2" size="$2">Last updated</SizableText>
                <SizableText color="#F2F7FF" fontWeight="700">{repo.updated}</SizableText>
              </YStack>
              <YStack flex={1} height={64} backgroundColor="#102844" borderRadius="$3" padding="$3" justifyContent="space-between">
                <SizableText color="#7E9BC2" size="$2">Primary stack</SizableText>
                <XStack alignItems="center" gap="$2"><Code2 size={14} color="#F4B860" /><SizableText color="#F2F7FF" fontWeight="700">{repo.language}</SizableText></XStack>
              </YStack>
            </XStack>
          </Card>

          <XStack gap="$3" flexWrap="wrap">
            <StatCard icon={<Star size={16} color="#F4B860" />} label="Stars" value={repo.stars.toLocaleString()} />
            <StatCard icon={<GitBranch size={16} color="#63D9FF" />} label="Forks" value={repo.forks.toLocaleString()} />
            <StatCard icon={<CircleAlert size={16} color="#6CE7C2" />} label="Open issues" value={repo.openIssues.toLocaleString()} />
          </XStack>

          <XStack backgroundColor="#0D1A2E" borderRadius="$4" padding="$1" gap="$1">
            <Button flex={1} height={44} backgroundColor={tab === 'overview' ? '#1C4B70' : 'transparent'} color={tab === 'overview' ? '#F2F7FF' : '#89A2C7'} onPress={() => { setTab('overview'); feedback(); }}>
              <BookOpen size={16} /> Overview
            </Button>
            <Button flex={1} height={44} backgroundColor={tab === 'issues' ? '#1C4B70' : 'transparent'} color={tab === 'issues' ? '#F2F7FF' : '#89A2C7'} onPress={() => { setTab('issues'); feedback(); }}>
              <CircleDot size={16} /> Issues {repo.openIssues > 0 ? `· ${repo.openIssues}` : ''}
            </Button>
          </XStack>

          {tab === 'overview' ? (
            <YStack gap="$3">
              <XStack justifyContent="space-between" alignItems="center">
                <H3 color="#F2F7FF" fontWeight="800">Quick actions</H3>
                <SizableText color="#63D9FF" size="$2">{repo.watchers} watching</SizableText>
              </XStack>
              <Card bordered backgroundColor="#101F35" borderColor="#213B60" padding="$1">
                <Button chromeless justifyContent="flex-start" height={56} paddingHorizontal="$3" onPress={feedback}>
                  <GitPullRequest size={19} color="#6CE7C2" /><YStack flex={1} alignItems="flex-start" marginLeft="$3"><SizableText color="#F2F7FF" fontWeight="700">Review pull requests</SizableText><SizableText color="#89A2C7" size="$2">Keep collaboration moving</SizableText></YStack><ChevronRight size={18} color="#58769E" />
                </Button>
                <Separator borderColor="#213B60" />
                <Button chromeless justifyContent="flex-start" height={56} paddingHorizontal="$3" onPress={() => { setTab('issues'); feedback(); }}>
                  <AlertCircle size={19} color="#F4B860" /><YStack flex={1} alignItems="flex-start" marginLeft="$3"><SizableText color="#F2F7FF" fontWeight="700">Triage open issues</SizableText><SizableText color="#89A2C7" size="$2">{repo.openIssues} threads need attention</SizableText></YStack><ChevronRight size={18} color="#58769E" />
                </Button>
                <Separator borderColor="#213B60" />
                <Button chromeless justifyContent="flex-start" height={56} paddingHorizontal="$3" onPress={feedback}>
                  <ShieldCheck size={19} color="#63D9FF" /><YStack flex={1} alignItems="flex-start" marginLeft="$3"><SizableText color="#F2F7FF" fontWeight="700">Open project security</SizableText><SizableText color="#89A2C7" size="$2">Check the repository posture</SizableText></YStack><ArrowUpRight size={18} color="#58769E" />
                </Button>
              </Card>
            </YStack>
          ) : (
            <YStack gap="$3">
              <XStack justifyContent="space-between" alignItems="center">
                <H3 color="#F2F7FF" fontWeight="800">Recent issues</H3>
                <Button chromeless paddingHorizontal="$2" onPress={() => refetch()}><SizableText color="#63D9FF" size="$3">Refresh</SizableText></Button>
              </XStack>
              {content.issues.length === 0 ? (
                <Card backgroundColor="#102844" padding="$4" alignItems="center" gap="$2"><CheckCircle2 size={32} color="#6CE7C2" /><SizableText color="#F2F7FF" fontWeight="700">All clear</SizableText><Paragraph color="#89A2C7" textAlign="center">No open issues are showing right now.</Paragraph></Card>
              ) : content.issues.map((issue) => (
                <Card key={issue.number} bordered backgroundColor="#101F35" borderColor="#213B60" padding="$4" gap="$3">
                  <XStack justifyContent="space-between" alignItems="flex-start" gap="$3"><XStack flex={1} gap="$2"><CircleDot size={18} color="#F4B860" marginTop="$1" /><SizableText color="#F2F7FF" fontWeight="700" size="$4">{issue.title}</SizableText></XStack><SizableText color="#6485AE" size="$2">#{issue.number}</SizableText></XStack>
                  <XStack alignItems="center" gap="$2"><YStack backgroundColor="#17334A" borderRadius="$2" paddingHorizontal="$2" paddingVertical="$1"><SizableText color="#63D9FF" size="$2" fontWeight="700">{issue.labels[0] || 'open'}</SizableText></YStack><SizableText color="#7895BB" size="$2">{issue.age}</SizableText></XStack>
                </Card>
              ))}
            </YStack>
          )}

          {isError && <Button chromeless onPress={() => refetch()}><SizableText color="#F4B860" size="$2">GitHub is rate-limited. Showing cached project data — tap to retry.</SizableText></Button>}
          <XStack alignItems="center" gap="$2" justifyContent="center" paddingTop="$2"><Users size={14} color="#58769E" /><SizableText color="#58769E" size="$2">Built for the malecyberfighters crew</SizableText></XStack>
        </YStack>
      </ScrollView>
    </YStack>
  );
}
