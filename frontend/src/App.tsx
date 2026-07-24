import { Route, Routes } from "react-router-dom";
import Landing from "./pages/Landing.js";
import Dashboard from "./pages/Dashboard.js";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/app" element={<Dashboard />} />
    </Routes>
  );
}
