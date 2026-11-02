import { BrowserRouter, Route, Routes } from 'react-router';
import { PhoneFrame } from './app/PhoneFrame.tsx';
import { LabGallery } from './components/lab/Gallery.tsx';
import { ChatScreen } from './screens/chat/Chat.tsx';
import { Home } from './screens/home/Home.tsx';
import { Intro } from './screens/intro/Intro.tsx';
import { KitScreen } from './screens/kit/Kit.tsx';
import { WatchScreen } from './screens/kit/Watch.tsx';
import { LibraryScreen } from './screens/library/Library.tsx';
import { PlanScreen } from './screens/plan/Plan.tsx';
import { ProtocolScreen } from './screens/protocol/Protocol.tsx';
import { ResultsScreen } from './screens/results/Results.tsx';
import { RunScreen } from './screens/run/Run.tsx';
import { ImportScreen } from './screens/share/Import.tsx';
import { ShareScreen } from './screens/share/Share.tsx';
import { StyleGuide } from './style-guide/StyleGuide.tsx';

// One route per screen; a screen's states (the + menu, listening, the sidebar) live inside it.
// /run/:step counts from 1, like the artboards ("Run · 1 standards"): it is useRun().step + 1.
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<PhoneFrame />}>
          <Route index element={<Home />} />
          <Route path="intro" element={<Intro />} />
          <Route path="chat" element={<ChatScreen />} />
          <Route path="protocol" element={<ProtocolScreen />} />
          <Route path="kit" element={<KitScreen />} />
          <Route path="watch" element={<WatchScreen />} />
          <Route path="plan" element={<PlanScreen />} />
          <Route path="run/:step" element={<RunScreen />} />
          <Route path="results" element={<ResultsScreen />} />
          <Route path="share" element={<ShareScreen />} />
          <Route path="import" element={<ImportScreen />} />
          <Route path="library" element={<LibraryScreen />} />
          <Route path="lab" element={<LabGallery />} />
        </Route>
        <Route path="style" element={<StyleGuide />} />
      </Routes>
    </BrowserRouter>
  );
}
