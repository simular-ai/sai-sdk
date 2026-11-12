# frozen_string_literal: true

require "timeout"

module Sai
  # Tenants: your customers, under an Organisation. Every call takes an Organisation Key. A tenant
  # argument is a Tenant or its id.
  class Tenants
    # +client+ exchanges again when its token has less than this left, in milliseconds.
    TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
    UNSET = Object.new.freeze
    private_constant :UNSET

    # @api private
    def initialize(http, org_id, with_credential)
      @http = http
      @org_id = org_id
      @with_credential = with_credential
    end

    # +external_id+ is your id for the customer, unique in the Organisation; it cannot change.
    # @return [Tenant]
    def create(name, external_id: nil, metadata: nil)
      body = { "name" => name }
      body["externalId"] = external_id unless external_id.nil?
      body["metadata"] = metadata unless metadata.nil?
      Tenant.parse(Parse.obj(@http.json("POST", "/v1/tenants", json: body)))
    end

    # One page, newest first. +external_id+ finds the Tenant with that id (zero or one) and cannot
    # be combined with +status+.
    # @return [TenantPage]
    def list(status: nil, external_id: nil, limit: nil, cursor: nil)
      params = { "status" => status, "externalId" => external_id, "limit" => limit, "cursor" => cursor }
      d = Parse.obj(@http.json("GET", "/v1/tenants", params: params))
      TenantPage.new(tenants: Parse.list(d["tenants"]).map { |t| Tenant.parse(Parse.obj(t)) },
                     next_cursor: Parse.str(d["nextCursor"]))
    end

    # @return [Tenant]
    def get(tenant)
      Tenant.parse(Parse.obj(@http.json("GET", self.class.path(tenant))))
    end

    # Sends only what is given. +metadata+ replaces the whole map. +status: "disabled"+ stops the
    # Tenant's tokens and machines; +"active"+ brings it back. +cloud_machine_limit+ (0 to 1000)
    # caps the Tenant's cloud machines, and +cloud_machine_limit: nil+ removes the cap.
    # +residential_proxy+ has no effect yet. +own_computer_access+ lets the Tenant's learn jobs and
    # direct control run code on its enrolled machines (default off). Only the Organisation Key or
    # an owner may set these three.
    # @return [Tenant]
    def update(tenant, name: nil, metadata: nil, status: nil, cloud_machine_limit: UNSET, residential_proxy: nil,
               own_computer_access: nil)
      body = {}
      body["name"] = name unless name.nil?
      body["metadata"] = metadata unless metadata.nil?
      body["status"] = status unless status.nil?
      body["cloudMachineLimit"] = cloud_machine_limit unless cloud_machine_limit.equal?(UNSET)
      body["residentialProxy"] = residential_proxy unless residential_proxy.nil?
      body["ownComputerAccess"] = own_computer_access unless own_computer_access.nil?
      Tenant.parse(Parse.obj(@http.json("PATCH", self.class.path(tenant), json: body)))
    end

    # Disables the Tenant and revokes every enrolled machine. Cloud machines stay and hibernate:
    # delete them with +tenant_machines.delete+.
    # @return [nil]
    def delete(tenant)
      @http.request("DELETE", self.class.path(tenant))
      nil
    end

    # A single-use code that enrolls one computer into the Tenant. It expires in 15 minutes.
    # @return [Enrollment]
    def create_enrollment(tenant)
      Enrollment.parse(Parse.obj(@http.json("POST", "#{self.class.path(tenant)}/enrollments")))
    end

    # Exchange the Organisation Key for a one-hour token that acts as the Tenant. +org_id+
    # defaults to the client's (+SAI_ORG_ID+).
    # @return [TenantToken]
    def token(tenant, org_id: nil)
      org = org_id || @org_id
      raise ArgumentError, "No Organisation id: pass org_id: here or to Sai::Client.new, or set SAI_ORG_ID." if org.nil? || org.empty?

      path = "/v1/orgs/#{Util.q(org)}/tenants/#{Util.q(Util.id_of(tenant))}/token"
      TenantToken.parse(Parse.obj(@http.json("POST", path)))
    end

    # A client that acts as the Tenant. It exchanges a token now, and again before a request when
    # the token has less than five minutes left, with this client's Organisation Key.
    # @return [Client]
    def client(tenant, org_id: nil)
      current = token(tenant, org_id: org_id)
      lock = Mutex.new
      @with_credential.call(lambda do
        lock.synchronize do
          current = token(tenant, org_id: org_id) if current.expires_at - Util.now_ms < TOKEN_REFRESH_MARGIN_MS
          current.token
        end
      end)
    end

    # @api private
    def self.path(tenant)
      "/v1/tenants/#{Util.q(Util.id_of(tenant))}"
    end
  end

  # A Tenant's computers, enrolled and cloud. Every call takes an Organisation Key.
  class TenantMachines
    # Between machine reads while +create(wait: true)+ waits.
    POLL_INTERVAL = 5

    # @api private
    def initialize(http)
      @http = http
    end

    # Create a cloud machine for the Tenant. +os+ is +windows+ or +linux+. +name+ (up to 64
    # characters) is a label you show your users. The same +request_id+ makes a retry safe.
    #
    # Returns at once with +state == "provisioning"+. +wait: true+ reads the machine until it is
    # +ready+; it raises Error (with the machine as +body+) if the machine fails or is deleted,
    # and Timeout::Error after +timeout+ seconds.
    # @return [TenantMachine]
    def create(tenant, os:, name: nil, request_id: nil, wait: false, timeout: 600)
      body = { "os" => os }
      body["name"] = name unless name.nil?
      body["requestId"] = request_id unless request_id.nil?
      machine = TenantMachine.parse(Parse.obj(@http.json("POST", "#{Tenants.path(tenant)}/machines", json: body)))
      return machine unless wait

      deadline = Util.monotonic + timeout
      while machine.state != "ready"
        if %w[failed deleting].include?(machine.state)
          raise Error.new("Cloud machine #{machine.id} is #{machine.state} and will not become ready.",
                          body: machine.raw)
        end
        raise Timeout::Error, "Cloud machine #{machine.id} still #{machine.state}." if Util.monotonic + POLL_INTERVAL > deadline

        sleep(POLL_INTERVAL)
        begin
          machine = get(tenant, machine.id)
        rescue RateLimitError => e
          sleep(e.retry_after.nil? ? 30 : e.retry_after)
        end
      end
      machine
    end

    # Both kinds, enrolled and cloud.
    # @return [Array<TenantMachine>]
    def list(tenant)
      d = Parse.obj(@http.json("GET", "#{Tenants.path(tenant)}/machines"))
      Parse.list(d["machines"]).map { |m| TenantMachine.parse(Parse.obj(m)) }
    end

    # @return [TenantMachine]
    def get(tenant, machine_id)
      TenantMachine.parse(Parse.obj(@http.json("GET", "#{Tenants.path(tenant)}/machines/#{Util.q(machine_id)}")))
    end

    # An enrolled machine is signed out at once (+"revoked"+). A cloud machine is deleted with its
    # disk (+"deleting"+), which cannot be undone.
    # @return [String] +"revoked"+ or +"deleting"+
    def delete(tenant, machine)
      res = @http.request("DELETE", "#{Tenants.path(tenant)}/machines/#{Util.q(Util.id_of(machine))}")
      res.status == 202 ? "deleting" : "revoked"
    end

    # +delete+ without its answer. On a cloud machine it deletes the machine: use +delete+.
    # @return [nil]
    def revoke(tenant, machine)
      delete(tenant, machine)
      nil
    end
  end
end
