import PavingMap from "@/components/PavingMap";

export default function Home() {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  return <PavingMap apiKey={apiKey} />;
}
