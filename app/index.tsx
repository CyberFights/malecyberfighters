import { useState } from 'react';
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import {
  Button,
  Card,
  ChevronRight,
  Circle,
  H2,
  Heart,
  Home as HomeIcon,
  Image,
  Input,
  Paragraph,
  Radio,
  ScrollView,
  SizableText,
  Sparkles,
  Star,
  Sword,
  Swords,
  Trophy,
  UserRound,
  XStack,
  YStack,
} from '@blinkdotnew/mobile-ui';

const fighters = [
  { name: 'Neon Ronin', className: 'Blade runner', rating: '2,480', color: '#FF4D8D', image: 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?auto=format&fit=crop&w=500&q=85' },
  { name: 'Null Vector', className: 'Code breaker', rating: '2,325', color: '#8B5CF6', image: 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=500&q=85' },
  { name: 'Chrome Saint', className: 'Signal monk', rating: '2,190', color: '#00D4B8', image: 'https://images.unsplash.com/photo-1534791547706-9a7f0f5f2f57?auto=format&fit=crop&w=500&q=85' },
];

const fights = [
  { title: 'Midnight Protocol', meta: '2v2 · Tokyo Sector', reward: '450 XP', live: true },
  { title: 'Firewall Cathedral', meta: 'Ranked duel · 3 min', reward: '680 XP', live: false },
];

async function tapFeedback() {
  if (Platform.OS !== 'web') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

export default function Home() {
  const [activeTab, setActiveTab] = useState('Arena');
  const [joined, setJoined] = useState(false);
  const [search, setSearch] = useState('');

  const joinFight = async () => {
    await tapFeedback();
    setJoined(true);
  };

  return (
    <YStack flex={1} backgroundColor="#090A12">
      <ScrollView flex={1} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 36 }}>
        <YStack paddingHorizontal="$4" paddingTop="$6" gap="$5">
          <XStack alignItems="center" justifyContent="space-between">
            <XStack alignItems="center" gap="$3">
              <Circle size={42} backgroundColor="#171322" borderWidth={1} borderColor="#FF4D8D">
                <SizableText color="#FF4D8D" size="$5" fontWeight="800">M</SizableText>
              </Circle>
              <YStack>
                <SizableText color="#7C7F93" size="$2" fontWeight="700" letterSpacing={1.5}>WELCOME BACK</SizableText>
                <SizableText color="#F8F7FF" size="$5" fontWeight="800">MALCOLM // 07</SizableText>
              </YStack>
            </XStack>
            <Button chromeless circular size="$4" icon={<Heart size={21} color="#F8F7FF" />} accessibilityLabel="Notifications" />
          </XStack>

          <YStack gap="$2">
            <SizableText color="#FF4D8D" size="$2" fontWeight="800" letterSpacing={2}>CYBERFIGHTS / 03</SizableText>
            <H2 color="#F8F7FF" fontSize={32} lineHeight={36} fontWeight="900" letterSpacing={-0.8}>THE ARENA IS<br />AWAITING.</H2>
            <Paragraph color="#9A9CAF" size="$4" maxWidth={310} lineHeight={22}>Deploy your fighter, break the firewall, and climb the global circuit.</Paragraph>
          </YStack>

          <Card backgroundColor="#141522" borderWidth={1} borderColor="#2C2D40" borderRadius="$5" overflow="hidden">
            <YStack padding="$4" gap="$4">
              <XStack justifyContent="space-between" alignItems="center">
                <XStack alignItems="center" gap="$2">
                  <Circle size={15} backgroundColor="#00D4B8" />
                  <SizableText color="#00D4B8" size="$2" fontWeight="800" letterSpacing={1.2}>LIVE CHALLENGE</SizableText>
                </XStack>
                <XStack backgroundColor="#2A1829" paddingHorizontal="$2" paddingVertical="$1" borderRadius="$2"><SizableText color="#FF4D8D" size="$2" fontWeight="800">RANKED</SizableText></XStack>
              </XStack>
              <YStack gap="$1">
                <SizableText color="#F8F7FF" size="$7" fontWeight="800">Blackout Relay</SizableText>
                <SizableText color="#85889C" size="$3">Enter before the signal drops in 04:28</SizableText>
              </YStack>
              <XStack alignItems="center" gap="$2">
                <Trophy size={17} color="#F5B942" />
                <SizableText color="#F5B942" size="$3" fontWeight="700">1,200 XP bounty</SizableText>
                <SizableText color="#626579" size="$3">·</SizableText>
                <SizableText color="#85889C" size="$3">128 fighters queued</SizableText>
              </XStack>
              <Button height={50} backgroundColor={joined ? '#00A88F' : '#FF4D8D'} color="#0C0B13" fontWeight="800" fontSize="$4" borderRadius="$3" onPress={joinFight} pressStyle={{ opacity: 0.82, scale: 0.98 }}>
                {joined ? 'QUEUE CONFIRMED' : 'ENTER THE FIGHT'}
              </Button>
            </YStack>
          </Card>

          <XStack justifyContent="space-between" alignItems="center">
            <SizableText color="#F8F7FF" size="$6" fontWeight="800">Featured fighters</SizableText>
            <Button chromeless paddingHorizontal="$1" color="#FF4D8D" fontSize="$3" onPress={tapFeedback} iconAfter={<ChevronRight size={15} color="#FF4D8D" />}>View all</Button>
          </XStack>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
            {fighters.map((fighter) => (
              <Button key={fighter.name} unstyled padding={0} width={174} height={218} backgroundColor="#151624" borderRadius="$4" overflow="hidden" borderWidth={1} borderColor="#292B3D" onPress={tapFeedback} pressStyle={{ opacity: 0.86, scale: 0.97 }}>
                <YStack flex={1} width="100%">
                  <Image source={{ uri: fighter.image }} width="100%" height={126} objectFit="cover" />
                  <YStack padding="$3" gap="$1">
                    <SizableText color="#F8F7FF" size="$4" fontWeight="800">{fighter.name}</SizableText>
                    <SizableText color="#85889C" size="$2">{fighter.className}</SizableText>
                    <XStack alignItems="center" gap="$1" marginTop="$1"><Star size={13} color={fighter.color} fill={fighter.color} /><SizableText color={fighter.color} size="$2" fontWeight="800">{fighter.rating}</SizableText></XStack>
                  </YStack>
                </YStack>
              </Button>
            ))}
          </ScrollView>

          <XStack justifyContent="space-between" alignItems="center" marginTop="$2">
            <SizableText color="#F8F7FF" size="$6" fontWeight="800">Active fights</SizableText>
            <XStack backgroundColor="#142B2B" paddingHorizontal="$2" paddingVertical="$1" borderRadius="$2"><SizableText color="#00D4B8" size="$2" fontWeight="800">{fights.length} OPEN</SizableText></XStack>
          </XStack>
          <YStack gap="$3">
            {fights.map((fight) => (
              <Card key={fight.title} backgroundColor="#11121E" borderWidth={1} borderColor="#27293A" borderRadius="$4">
                <Card.Header padded>
                  <XStack alignItems="center" justifyContent="space-between">
                    <XStack alignItems="center" gap="$3" flex={1}>
                      <Circle size={40} backgroundColor={fight.live ? '#2A1829' : '#19233A'}><Swords size={19} color={fight.live ? '#FF4D8D' : '#8B9FFF'} /></Circle>
                      <YStack flex={1} gap="$1"><SizableText color="#F8F7FF" size="$4" fontWeight="700">{fight.title}</SizableText><SizableText color="#85889C" size="$2">{fight.meta}</SizableText></YStack>
                    </XStack>
                    <YStack alignItems="flex-end" gap="$1"><SizableText color="#F5B942" size="$3" fontWeight="800">{fight.reward}</SizableText><SizableText color={fight.live ? '#00D4B8' : '#626579'} size="$2" fontWeight="700">{fight.live ? 'LIVE' : 'STARTING SOON'}</SizableText></YStack>
                  </XStack>
                </Card.Header>
              </Card>
            ))}
          </YStack>

          <Card backgroundColor="#10111C" borderWidth={1} borderColor="#27293A" borderRadius="$4">
            <Card.Header padded><XStack alignItems="center" gap="$3"><Circle size={38} backgroundColor="#211B32"><Sparkles size={18} color="#B18CFF" /></Circle><YStack flex={1}><SizableText color="#F8F7FF" size="$3" fontWeight="800">Your next unlock</SizableText><SizableText color="#85889C" size="$2">420 XP to unlock the Spectre skin</SizableText></YStack><SizableText color="#B18CFF" size="$3" fontWeight="800">72%</SizableText></XStack></Card.Header>
          </Card>
        </YStack>
      </ScrollView>

      <YStack paddingHorizontal="$4" paddingTop="$3" paddingBottom="$4" backgroundColor="#0E0F19" borderTopWidth={1} borderColor="#202131" gap="$3">
        <Input value={search} onChangeText={setSearch} placeholder="Search the circuit" placeholderTextColor="#626579" backgroundColor="#181A29" borderWidth={0} borderRadius="$3" height={44} color="#F8F7FF" paddingHorizontal="$3" />
        <XStack justifyContent="space-around" alignItems="center">
          {[
            { label: 'Arena', icon: <HomeIcon size={19} /> },
            { label: 'Fighters', icon: <UserRound size={19} /> },
            { label: 'Rankings', icon: <Trophy size={19} /> },
            { label: 'Profile', icon: <Sword size={19} /> },
          ].map((item) => <Button key={item.label} chromeless onPress={() => { setActiveTab(item.label); tapFeedback(); }} color={activeTab === item.label ? '#FF4D8D' : '#626579'} icon={item.icon} fontSize="$2" fontWeight="700" minHeight={44}>{item.label}</Button>)}
        </XStack>
      </YStack>
    </YStack>
  );
}
