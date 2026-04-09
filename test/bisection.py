"""
二分法（对分法）求解 f(x) = 0 的近似根。
要求区间 [a, b] 上 f 连续，且 f(a) 与 f(b) 异号。
"""

from __future__ import annotations

import math
from collections.abc import Callable


def bisection(
    f: Callable[[float], float],
    a: float,
    b: float,
    tol: float = 1e-10,
    max_iter: int = 1000,
) -> tuple[float, int]:
    """
    在 [a, b] 上用二分法求 f(x)=0 的根。

    :param f: 目标函数
    :param a: 区间左端
    :param b: 区间右端
    :param tol: 当区间长度小于 tol 或 |f(mid)| < tol 时停止
    :param max_iter: 最大迭代次数
    :return: (近似根, 实际迭代次数)
    :raises ValueError: f(a)*f(b)>=0 时无法保证有唯一根条件
    """
    fa, fb = f(a), f(b)
    if fa * fb > 0:
        raise ValueError("f(a) 与 f(b) 需异号（或其一为 0），请换一个区间。")
    if fa == 0:
        return a, 0
    if fb == 0:
        return b, 0

    n = 0
    while n < max_iter and (b - a) > tol:
        mid = (a + b) / 2.0
        fm = f(mid)
        n += 1
        if abs(fm) < tol:
            return mid, n
        if fa * fm < 0:
            b, fb = mid, fm
        else:
            a, fa = mid, fm

    root = (a + b) / 2.0
    return root, n


def main() -> None:
    # 示例：求 x^2 - 2 = 0 的正根，即 sqrt(2)
    def g(x: float) -> float:
        return x * x - 2.0

    root, iters = bisection(g, 1.0, 2.0)
    truth = math.sqrt(2.0)
    print(f"方程 x^2 - 2 = 0 在 [1, 2] 上的近似根: {root}")
    print(f"迭代次数: {iters}, |根 - sqrt(2)| = {abs(root - truth):.2e}")


if __name__ == "__main__":
    main()
