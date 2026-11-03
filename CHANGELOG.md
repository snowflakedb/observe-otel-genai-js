# Changelog

All notable changes to this project will be documented in this file. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- OpenAI: `gen_ai.provider.name` comes from the client's base URL host, so an
  OpenAI client pointed at Snowflake Cortex, Azure, Bedrock, Groq, DeepSeek, xAI,
  Mistral or Gemini no longer reports `openai`. Unknown hosts still report
  `openai`.
- LangChain adapter: a `ChatOpenAI` built with a `configuration.baseURL` reports
  the provider of that host the same way.
- Claude Agent SDK: with no routing flag set, `gen_ai.provider.name` is the
  provider of `ANTHROPIC_BASE_URL`, such as `snowflake` for Snowflake Cortex.
- Vercel AI SDK: models from `createBedrockMantle` (`bedrock-mantle.*`) and
  `createBedrockAnthropic` (`bedrock.anthropic.messages`) report `aws.bedrock`
  instead of the raw AI SDK provider id.

## [0.1.0] - 2026-11-02

First release.

### Added
- Spans for model calls, embeddings, tool calls, retrievals, agent runs,
  workflow runs and agent creation, and six GenAI histograms, following the
  GenAI semantic conventions.
- Instrumentations for the OpenAI SDK, OpenAI Agents SDK, LangChain.js and
  LangGraph, Claude Agent SDK and Vercel AI SDK, and a client wrapper for the
  Anthropic SDK.
