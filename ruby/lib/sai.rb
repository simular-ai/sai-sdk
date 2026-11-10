# frozen_string_literal: true

# Ruby SDK for the Sai API.
#
# - +sai.sessions+: give Sai a task on a computer and get the answer back.
# - +sai.learn+, +sai.judge+: turn recorded turns or a task into Simulang code, repair it, run,
#   judge and repair it on a machine, judge turns.
# - +sai.control+: drive a computer yourself with Simulang.
# - +sai.machines+, +sai.models+, +sai.files+, +sai.account+, +sai.auth+.
# - +sai.tenants+, +sai.tenant_machines+, +sai.usage+: your customers under an Organisation.
module Sai
end

require_relative "sai/version"
require_relative "sai/errors"
require_relative "sai/util"
require_relative "sai/http"
require_relative "sai/types"
require_relative "sai/machines"
require_relative "sai/turns"
require_relative "sai/sessions"
require_relative "sai/learn"
require_relative "sai/control"
require_relative "sai/tenants"
require_relative "sai/client"
