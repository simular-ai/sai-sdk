package ai.simular.sai;

import java.util.Map;

/**
 * What stands in the way of driving a machine, as the Sai runtime on it last reported. Each field
 * is null when nothing was found in the way (a check that cannot tell counts as fine), else a
 * sentence for the user saying what is missing and how to fix it.
 * See <a
 * href="https://platform.simular.ai/documentation/organisations/tenant-machines#machine-capabilities">machine
 * capabilities</a>.
 *
 * @param canSee screenshots show what is on screen
 * @param canUseAccessibility other apps' accessibility trees can be read and acted on
 * @param canControl mouse, keyboard and element actions reach other apps; needs what {@code
 *     canUseAccessibility} needs
 */
public record MachineCapabilities(String canSee, String canUseAccessibility, String canControl) {

  /** Null unless {@code v} is an object whose three answers are each a string or null. */
  static MachineCapabilities parse(Object v) {
    if (!(v instanceof Map<?, ?> d)) return null;
    for (String key : new String[] {"canSee", "canUseAccessibility", "canControl"}) {
      if (!d.containsKey(key)) return null;
      Object x = d.get(key);
      if (x != null && !(x instanceof String)) return null;
    }
    return new MachineCapabilities(
        (String) d.get("canSee"), (String) d.get("canUseAccessibility"), (String) d.get("canControl"));
  }
}
