# OpenPE documentation

Choose a workflow below. Each feature contract owns its detailed behaviour and limits; the [engineering contract](../AGENTS.md) defines contribution requirements.

<!-- prettier-ignore -->
| Work | Read |
| --- | --- |
| Install, develop, check or package | [Setup and development](DEVELOPMENT.md) |
| Use the workspace and its controls | [Design](../DESIGN.md) |
| Edit PCB layout or Model CAD | [Layout and Model](LAYOUT.md) · [ERC/DRC](DESIGN-RULES.md) |
| Save, export or inspect native files | [Native format](FORMAT.md) · [Version history](VERSION-HISTORY.md) |
| Run electrical, thermal or EMC analysis | [SPICE](SIMULATION.md) · [Layout Thermal](THERMAL.md) · [PCB parasitics](LAYOUT.md#layout-parasitics) · [EMC Analysis](EMC.md) |
| Explore reference designs and resources | [Examples](EXAMPLES.md) · [EMC Flyback](EMC-FLYBACK.md) · [Datasheets](DATASHEETS.md) · [Libraries and licenses](LIBRARIES.md) |
| Configure bundled features or provider plugins | [Plugins](PLUGINS.md) |
| Understand or extend the implementation | [Architecture](ARCHITECTURE.md) · [Diagram](../assets/architecture.drawio) · [Core](CORE.md) · [API](API.md) |

## Coverage and limits

OpenPE supports a bounded subset of KiCad 10 and Model CAD, including manual PCB placement and routing. General CAD/model import, complete KiCad ERC/DRC parity, autorouting and production qualification are outside its scope.

Review CAM and assembly files before manufacturing. [Manufacturing export](FORMAT.md#manufacturing-export)
