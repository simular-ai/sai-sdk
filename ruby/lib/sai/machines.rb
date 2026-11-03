# frozen_string_literal: true

module Sai
  # The computers Sai works on: cloud computers, or the customer's own PC with the Sai app.
  class Machines
    # @api private
    def initialize(http)
      @http = http
    end

    # @return [Array<Machine>]
    def list
      d = @http.json("GET", "/v1/agents/machines") || {}
      Parse.list(d["machines"]).map { |m| Machine.parse(m) }
    end

    # @raise [NotFoundError] when the machine is not on this account
    def get(machine_id)
      m = list.find { |x| x.id == machine_id }
      raise NotFoundError.new("Machine #{machine_id} not found on this account.", status: 404) unless m

      m
    end

    # The live screen: +live_url+, a page a person can open without a Simular sign-in, and a
    # Guacamole tunnel for a viewer of your own. The machine must be running.
    # @return [LiveView]
    def live(machine)
      id = Util.id_of(machine)
      d = @http.json("POST", "/v1/agents/machines/#{Util.q(id)}/live") || {}
      LiveView.new(
        machine_id: Parse.str(d["machineId"]) || id,
        live_url: Parse.str(d["liveUrl"]),
        expires_at: Parse.num_or_nil(d["expiresAt"]),
        websocket_url: d["websocketUrl"].to_s,
        width: Parse.num(d["width"]),
        height: Parse.num(d["height"])
      )
    end

    # Revokes every +live_url+ handed out for the machine.
    # @return [Integer] how many were revoked
    def revoke_live(machine)
      d = @http.json("DELETE", "/v1/agents/machines/#{Util.q(Util.id_of(machine))}/live")
      Parse.num(Parse.obj(d)["revoked"])
    end
  end
end
