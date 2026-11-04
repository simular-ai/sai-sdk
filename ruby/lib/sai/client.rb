# frozen_string_literal: true

module Sai
  # The Sai API client.
  #
  #   sai = Sai::Client.new # SAI_API_KEY, and SAI_API_URL if set
  #   session = sai.sessions.create
  #   puts session.run("Open Notepad and type hello").text
  class Client
    attr_reader :machines, :sessions, :turns, :control, :models, :files, :account, :tenant_machines
    # Recorded turns → Simulang code, and code repair (research preview).
    attr_reader :learn
    # Judge recorded turns against new criteria (research preview).
    attr_reader :judge
    # Who the key acts as.
    attr_reader :auth
    # What an Organisation is charged, per Tenant and per session. Takes an Organisation Key.
    attr_reader :usage
    # Your customers under an Organisation. Takes an Organisation Key.
    attr_reader :tenants

    # +api_key+ defaults to +SAI_API_KEY+, +base_url+ to +SAI_API_URL+ then
    # +https://api.simular.ai+, +org_id+ (the Organisation +tenants.token+, +tenants.client+ and
    # +usage+ act on; only an Organisation Key needs it) to +SAI_ORG_ID+. +timeout+ is seconds
    # per request; +version_tag+ routes requests to a tagged API revision.
    def initialize(api_key: nil, base_url: nil, timeout: 60, version_tag: nil, org_id: nil)
      key = api_key || ENV.fetch("SAI_API_KEY", nil)
      if key.nil? || key.empty?
        raise ArgumentError, "No API key: pass api_key: or set SAI_API_KEY. Create one at https://platform.simular.ai."
      end

      setup(key, base_url: base_url, timeout: timeout, version_tag: version_tag, org_id: org_id)
    end

    # @api private
    # A client whose bearer token comes from +credential+ before each request (+tenants.client+).
    def self.with_credential(credential, **opts)
      allocate.tap { |c| c.send(:setup, credential, **opts) }
    end
    private_class_method :with_credential

    def inspect
      "#<Sai::Client>"
    end

    private

    def setup(credential, base_url:, timeout:, version_tag:, org_id:)
      url = base_url || ENV.fetch("SAI_API_URL", nil)
      url = DEFAULT_BASE_URL if url.nil? || url.empty?
      org = org_id.nil? ? ENV.fetch("SAI_ORG_ID", nil) : org_id
      http = Http.new(credential, url, timeout, version_tag)
      opts = { base_url: base_url, timeout: timeout, version_tag: version_tag, org_id: org_id }
      @machines = Machines.new(http)
      @sessions = Sessions.new(http, @machines)
      @turns = Turns.new(http)
      @learn = Learn.new(http)
      @judge = Judge.new(http)
      @control = Control.new(http)
      @models = Models.new(http)
      @files = Files.new(http)
      @account = AccountResource.new(http)
      @auth = Auth.new(http)
      @usage = UsageResource.new(http, org)
      @tenants = Tenants.new(http, org, ->(c) { Client.send(:with_credential, c, **opts) })
      @tenant_machines = TenantMachines.new(http)
    end
  end

  # Models a session can run on.
  class Models
    # @api private
    def initialize(http)
      @http = http
    end

    # +allowed+ says whether this plan may use each.
    # @return [Array<Model>]
    def list
      d = Parse.obj(@http.json("GET", "/v1/agents/models"))
      Parse.list(d["models"]).map { |m| Model.parse(Parse.obj(m)) }
    end
  end

  # Files to attach to a message.
  class Files
    # @api private
    def initialize(http)
      @http = http
    end

    # Upload one file (max 25 MB): a path, or the bytes as +data:+ with a +name:+. +name+ defaults
    # to the path's file name.
    # @return [Attachment]
    def upload(path = nil, data: nil, name: nil)
      raise ArgumentError, "pass a path, or data: with name:" if path.nil? == data.nil?

      if path
        data = File.binread(path.to_s)
        name ||= File.basename(path.to_s)
      end
      raise ArgumentError, "name: is required with data:" if name.nil?

      d = @http.json("POST", "/v1/agents/upload",
                     body: data.b,
                     # The server reads only a body that has a Content-Type; it derives the MIME
                     # type from the name.
                     headers: { "Content-Type" => "application/octet-stream", "x-filename" => Util.q(name) },
                     timeout: 120)
      Attachment.parse(Parse.obj(d))
    end
  end

  # The account's plan and credit.
  class AccountResource
    # @api private
    def initialize(http)
      @http = http
    end

    # Plan and spendable credit. Slow-ish (billing lookup): not for a poll loop.
    # @return [Account]
    def get
      Account.parse(Parse.obj(@http.json("GET", "/v1/agents/account")))
    end
  end

  # Who the key acts as.
  class Auth
    # @api private
    def initialize(http)
      @http = http
    end

    # Raises AuthenticationError for a missing or revoked key.
    # @return [AuthInfo]
    def check
      AuthInfo.parse(Parse.obj(@http.json("GET", "/v1/agents/auth")))
    end
  end

  # What an Organisation is charged. Takes an Organisation Key; +org_id+ defaults to the client's.
  class UsageResource
    # @api private
    def initialize(http, org_id)
      @http = http
      @org_id = org_id
    end

    # What the Organisation is charged, in total and per Tenant, per +granularity+ (+hour+, +day+
    # or +month+; default +day+) from +from+ to +to+: +2026-10+ for a month, +2026-10-15+ for a
    # day, +2026-10-15T09+ for an hour. Each defaults to a range that ends now.
    # @return [OrgUsage]
    def get(granularity: nil, from: nil, to: nil, org_id: nil)
      params = { "granularity" => granularity, "from" => from, "to" => to }
      OrgUsage.parse(Parse.obj(@http.json("GET", "/v1/orgs/#{Util.q(org(org_id))}/usage", params: params)))
    end

    # One page of what each of a Tenant's sessions spent on AI calls, oldest first, for the UTC
    # days +from+ to +to+ (+YYYY-MM-DD+, both included, at most 93 days). Keep paging with
    # +next_cursor+ until it is nil: a page can be empty and not be the last.
    #
    # With +session_ids+ (1 to 50) instead of the range, the named sessions' spend right now, each
    # with +settled+, and the page's +as_of+; no paging. Charge for a task once its session is
    # settled.
    # @return [SessionSpendPage]
    def sessions(tenant, from: nil, to: nil, limit: nil, cursor: nil, session_ids: nil, org_id: nil)
      params = { "tenantId" => Util.id_of(tenant), "from" => from, "to" => to, "limit" => limit, "cursor" => cursor,
                 "sessionIds" => session_ids.nil? || session_ids.empty? ? nil : session_ids.join(",") }
      d = @http.json("GET", "/v1/orgs/#{Util.q(org(org_id))}/usage/sessions", params: params)
      SessionSpendPage.parse(Parse.obj(d))
    end

    private

    def org(org_id)
      id = org_id || @org_id
      raise ArgumentError, "No Organisation id: pass org_id: here or to Sai::Client.new, or set SAI_ORG_ID." if id.nil? || id.empty?

      id
    end
  end
end
