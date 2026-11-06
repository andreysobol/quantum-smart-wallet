// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {EACBaseRolesLib} from "@ensdomains/contracts-v2/access-control/libraries/EACBaseRolesLib.sol";
import {
    Grant,
    IPermissionedResolverInitializable
} from "@ensdomains/contracts-v2/resolver/interfaces/IPermissionedResolverInitializable.sol";
import {IVerifiableFactory} from "@ensdomains/verifiable-factory/IVerifiableFactory.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title Name vault for one QuantumAccount.
/// @notice ENSv2 registries mint names as ERC-1155 tokens and call onERC1155Received on contract owners.
/// QuantumAccount has no receiver hooks, so this vault holds the tokens and the account controls it.
/// @dev CONTROLLER is the only caller of execute(): there is no owner, operator, upgrade or recovery path.
/// The vault deploys its own official PermissionedResolver proxy and holds every role on it, so the
/// records of its names can only change through the controller.
contract ENSVault is IERC1155Receiver, IERC721Receiver {
    /// @notice The QuantumAccount that alone acts through this vault.
    address public immutable CONTROLLER;
    /// @notice This vault's PermissionedResolver proxy (VerifiableFactory salt 0, deployed by the vault).
    address public immutable RESOLVER;

    error InvalidController();
    error UnauthorizedCaller(address caller);

    event Executed(address indexed target, bytes4 indexed selector);

    constructor(address controller, IVerifiableFactory proxyFactory, address resolverImplementation) {
        if (controller.code.length == 0) revert InvalidController();
        CONTROLLER = controller;
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(address(this), EACBaseRolesLib.ALL_ROLES);
        RESOLVER = proxyFactory.deployProxy(
            resolverImplementation,
            0,
            abi.encodeCall(IPermissionedResolverInitializable.initialize, (grants, new bytes[](0)))
        );
    }

    /// @notice Call `target` as this vault. Only the controller, through a SENDER frame of its own
    /// PQ-validated transaction, can use it: to set records, change the resolver or transfer a name.
    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != CONTROLLER) revert UnauthorizedCaller(msg.sender);
        bool ok;
        (ok, result) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
        emit Executed(target, bytes4(data));
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IERC1155Receiver).interfaceId
            || interfaceId == type(IERC721Receiver).interfaceId;
    }
}
