package ai.simular.sai;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** The models a session can run on. */
public final class Models {
  private final Http http;

  Models(Http http) {
    this.http = http;
  }

  /** Models a session can run on; {@code allowed} says whether this plan may use each. */
  public List<Model> list() {
    List<Model> out = new ArrayList<>();
    for (Map<String, Object> m : Json.objects(http.object("GET", "/v1/agents/models").get("models"))) {
      out.add(Model.parse(m));
    }
    return Collections.unmodifiableList(out);
  }
}
