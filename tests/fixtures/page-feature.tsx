export function Page() {
  const value = computeFeatureState()
  return <Login value={value} />
}
