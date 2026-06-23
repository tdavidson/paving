import PavingMap from "@/components/PavingMap";

const GITHUB_REPO = "tdavidson/paving";

// Fetch the star count on the server with Next's fetch cache so it is
// refreshed at most once an hour instead of on every page load.
async function getStarCount(): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.stargazers_count === "number"
      ? data.stargazers_count
      : null;
  } catch {
    return null;
  }
}

export default async function Home() {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const stars = await getStarCount();
  return <PavingMap apiKey={apiKey} githubRepo={GITHUB_REPO} stars={stars} />;
}
