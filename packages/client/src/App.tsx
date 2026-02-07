import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import PermitsPage from "./pages/PermitsPage";
import PermitDetailPage from "./pages/PermitDetailPage";
import BookingPage from "./pages/BookingPage";
import SniperPage from "./pages/SniperPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<PermitsPage />} />
        <Route path="/permits/:permitId" element={<PermitDetailPage />} />
        <Route path="/booking" element={<BookingPage />} />
        <Route path="/sniper" element={<SniperPage />} />
      </Route>
    </Routes>
  );
}
