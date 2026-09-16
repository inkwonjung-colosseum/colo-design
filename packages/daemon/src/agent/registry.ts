import type { AgentDriver } from "./driver.js";

/**
 * The provider registry: id → driver. Sessions name their provider at create
 * time (`SessionOptions.provider`, default "claude"); the manager resolves it
 * here. Registration order is the picker order.
 */
export class DriverRegistry {
  private readonly drivers = new Map<string, AgentDriver>();

  register(driver: AgentDriver): void {
    this.drivers.set(driver.id, driver);
  }

  get(id: string): AgentDriver | undefined {
    return this.drivers.get(id);
  }

  require(id: string): AgentDriver {
    const driver = this.drivers.get(id);
    if (!driver) throw new Error(`알 수 없는 에이전트입니다: ${id}`);
    return driver;
  }

  all(): AgentDriver[] {
    return [...this.drivers.values()];
  }
}
