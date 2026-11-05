// Test-wide environment: the offline mock model is available, and nothing
// writes into the developer's real data directory.
process.env.MOCK_LLM = "1";
