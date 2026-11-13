package ai.simular.sai;

import java.net.http.HttpClient;
import java.time.Duration;
import java.util.function.Supplier;

/**
 * The Sai API client.
 *
 * <pre>{@code
 * Sai sai = new Sai(); // SAI_API_KEY, and SAI_API_URL if set
 * Session session = sai.sessions().create();
 * System.out.println(session.run("Open Notepad and type hello").text());
 * }</pre>
 */
public final class Sai {
  /** This SDK's version, sent in {@code User-Agent} as {@code sai-java/<version>}. */
  public static final String VERSION = "0.2.1";

  static final String DEFAULT_BASE_URL = "https://api.simular.ai";

  private final Machines machines;
  private final Sessions sessions;
  private final Turns turns;
  private final Learn learn;
  private final Judge judge;
  private final Control control;
  private final Models models;
  private final FilesResource files;
  private final AccountResource account;
  private final Auth auth;
  private final UsageResource usage;
  private final Tenants tenants;
  private final TenantMachines tenantMachines;

  /** A client from the environment: {@code SAI_API_KEY}, {@code SAI_API_URL}, {@code SAI_ORG_ID}. */
  public Sai() {
    this(builder(), null);
  }

  private Sai(Builder b, Supplier<String> credential) {
    String key = b.apiKey != null ? b.apiKey : System.getenv("SAI_API_KEY");
    if (credential == null) {
      if (key == null || key.isEmpty()) {
        throw new IllegalStateException(
            "No API key: pass apiKey or set SAI_API_KEY. Create one at https://platform.simular.ai.");
      }
      credential = () -> key;
    }
    String envUrl = System.getenv("SAI_API_URL");
    String baseUrl =
        b.baseUrl != null ? b.baseUrl : envUrl != null && !envUrl.isEmpty() ? envUrl : DEFAULT_BASE_URL;
    HttpClient client =
        b.httpClient != null
            ? b.httpClient
            : HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NORMAL).build();
    Http http =
        new Http(credential, baseUrl, b.timeout != null ? b.timeout : Duration.ofSeconds(60), b.versionTag, client);
    String orgId = b.orgId != null ? b.orgId : System.getenv("SAI_ORG_ID");
    this.machines = new Machines(http);
    this.sessions = new Sessions(http, machines);
    this.turns = new Turns(http);
    this.learn = new Learn(http);
    this.judge = new Judge(http);
    this.control = new Control(http);
    this.models = new Models(http);
    this.files = new FilesResource(http);
    this.account = new AccountResource(http);
    this.auth = new Auth(http);
    this.usage = new UsageResource(http, orgId);
    Builder same = b.copy().httpClient(client);
    this.tenants = new Tenants(http, orgId, c -> new Sai(same, c));
    this.tenantMachines = new TenantMachines(http);
  }

  public static Builder builder() {
    return new Builder();
  }

  /** The computers Sai works on. */
  public Machines machines() {
    return machines;
  }

  /** Conversations with Sai on a computer. */
  public Sessions sessions() {
    return sessions;
  }

  /** A turn's record: typed output, evidence, trajectory. */
  public Turns turns() {
    return turns;
  }

  /** Recorded turns → Simulang code, and code repair (research preview). */
  public Learn learn() {
    return learn;
  }

  /** Judge recorded turns against new criteria (research preview). */
  public Judge judge() {
    return judge;
  }

  /** Drive a computer yourself with Simulang (research preview). */
  public Control control() {
    return control;
  }

  public Models models() {
    return models;
  }

  public FilesResource files() {
    return files;
  }

  public AccountResource account() {
    return account;
  }

  /** Who the key acts as. */
  public Auth auth() {
    return auth;
  }

  /** What an Organisation is charged, per Tenant and per session. Takes an Organisation Key. */
  public UsageResource usage() {
    return usage;
  }

  /** Your customers under an Organisation. Takes an Organisation Key. */
  public Tenants tenants() {
    return tenants;
  }

  /** A Tenant's computers: enrolled, and cloud machines Sai hosts. Takes an Organisation Key. */
  public TenantMachines tenantMachines() {
    return tenantMachines;
  }

  /** Options for a {@link Sai} client. Each one left out comes from the environment or a default. */
  public static final class Builder {
    private String apiKey;
    private String baseUrl;
    private Duration timeout;
    private String versionTag;
    private String orgId;
    private HttpClient httpClient;

    private Builder() {}

    /** Defaults to {@code SAI_API_KEY}. */
    public Builder apiKey(String apiKey) {
      this.apiKey = apiKey;
      return this;
    }

    /** Defaults to {@code SAI_API_URL}, then {@code https://api.simular.ai}. */
    public Builder baseUrl(String baseUrl) {
      this.baseUrl = baseUrl;
      return this;
    }

    /** Per request. Default 60 s. */
    public Builder timeout(Duration timeout) {
      this.timeout = timeout;
      return this;
    }

    /** Routes requests to a tagged API revision ({@code x-sai-version}). */
    public Builder versionTag(String versionTag) {
      this.versionTag = versionTag;
      return this;
    }

    /**
     * The Organisation that {@code tenants().token()}, {@code tenants().client()} and {@code usage()}
     * act on. Defaults to {@code SAI_ORG_ID}. Only an Organisation Key needs it.
     */
    public Builder orgId(String orgId) {
      this.orgId = orgId;
      return this;
    }

    /** Replace the HTTP client, e.g. for a proxy. */
    public Builder httpClient(HttpClient httpClient) {
      this.httpClient = httpClient;
      return this;
    }

    public Sai build() {
      return new Sai(this, null);
    }

    Builder copy() {
      Builder c = new Builder();
      c.apiKey = apiKey;
      c.baseUrl = baseUrl;
      c.timeout = timeout;
      c.versionTag = versionTag;
      c.orgId = orgId;
      c.httpClient = httpClient;
      return c;
    }
  }
}
