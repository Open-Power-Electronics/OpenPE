# Contributing to OpenPE

## Report an issue

[Open a GitHub issue](https://github.com/Open-Power-Electronics/OpenPE/issues/new) with your operating system, the OpenPE version or commit, how you installed it, and the steps to reproduce the issue. Include a small project you can share when it helps reproduce the problem.

## Submit a change

Code changes currently come from the OpenPE core team. Core developers follow these steps:

1. Set up your checkout with the [development guide](docs/DEVELOPMENT.md).
2. Read the [engineering contract](AGENTS.md) and follow the feature contracts it points to for the area you are changing.
3. Keep each pull request focused. Update the affected documentation with the change. Maintained documentation and UI copy are in English.
4. Run the checks in [Verification and delivery](AGENTS.md#verification-and-delivery) that apply to your change.
5. Open a pull request against `main`. Explain what changed, which checks you ran and on which hosts, and what still needs verification.

## Third-party materials

Record the source and license of third-party files, models, footprints and datasheets. Follow the provenance and notice requirements in [Examples](docs/EXAMPLES.md) and [Libraries](docs/LIBRARIES.md).

## License

OpenPE is licensed under [Apache-2.0](LICENSE). Section 5 of that license governs the terms of contributions submitted for inclusion.
