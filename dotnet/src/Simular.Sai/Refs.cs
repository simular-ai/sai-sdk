namespace Simular.Sai;

/// <summary>A machine id, or a <see cref="Machine"/>.</summary>
public sealed class MachineRef(string id)
{
    public string Id { get; } = id;

    public static implicit operator MachineRef(string id) => new(id);

    public static implicit operator MachineRef(Machine machine) => new(machine.Id);
}

/// <summary>A Tenant id, or a <see cref="Tenant"/>.</summary>
public sealed class TenantRef(string id)
{
    public string Id { get; } = id;

    public static implicit operator TenantRef(string id) => new(id);

    public static implicit operator TenantRef(Tenant tenant) => new(tenant.Id);
}

/// <summary>A Tenant machine id, or a <see cref="TenantMachine"/>.</summary>
public sealed class TenantMachineRef(string id)
{
    public string Id { get; } = id;

    public static implicit operator TenantMachineRef(string id) => new(id);

    public static implicit operator TenantMachineRef(TenantMachine machine) => new(machine.Id);
}

/// <summary>A turn id, a <see cref="Turn"/>, or a <see cref="TurnRecord"/>.</summary>
public sealed class TurnRef(string? id)
{
    /// <summary>Null for a message answered without starting a turn.</summary>
    public string? Id { get; } = id;

    public static implicit operator TurnRef(string id) => new(id);

    public static implicit operator TurnRef(Turn turn) => new(turn.Id);

    public static implicit operator TurnRef(TurnRecord record) => new(record.Id);

    internal string RequireId() =>
        Id ?? throw new InvalidOperationException("This turn has no id: the message was answered without starting one.");
}

/// <summary>A learn id, or a <see cref="LearnResult"/>.</summary>
public sealed class LearnRef(string id)
{
    public string Id { get; } = id;

    public static implicit operator LearnRef(string id) => new(id);

    public static implicit operator LearnRef(LearnResult result) => new(result.Id);
}

/// <summary>A judgement id, or a <see cref="Judgement"/>.</summary>
public sealed class JudgementRef(string id)
{
    public string Id { get; } = id;

    public static implicit operator JudgementRef(string id) => new(id);

    public static implicit operator JudgementRef(Judgement judgement) => new(judgement.Id);
}
