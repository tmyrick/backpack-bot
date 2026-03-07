import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import PermitsPage from "./pages/PermitsPage";
import PermitDetailPage from "./pages/PermitDetailPage";
import BookingPage from "./pages/BookingPage";
import SniperPage from "./pages/SniperPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<SniperPage />} />
        <Route path="/sniper" element={<Navigate to="/" replace />} />
        <Route path="/permits" element={<PermitsPage />} />
        <Route path="/permits/:permitId" element={<PermitDetailPage />} />
        <Route path="/booking" element={<BookingPage />} />
      </Route>
    </Routes>
  );
}
